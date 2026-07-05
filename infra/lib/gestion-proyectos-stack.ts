import { Duration, CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface GestionProyectosStackProps extends StackProps {
  appName: string;
  envName: string;
  initialUserEmail: string;
  /**
   * ARN de un rol de ejecución pre-creado para la Lambda. En cuentas gobernadas
   * (producción), donde la identidad de despliegue no puede gestionar IAM, el
   * admin crea el rol con privilegios mínimos (DynamoDB de la app + logs +
   * Glue de solo lectura) y se pasa aquí; el stack lo consume sin tocar IAM.
   * Si se omite (dev), el stack crea el rol como siempre.
   */
  apiRoleArn?: string;
}

const MODULES = ["home", "projects", "tasks", "catalog", "admin"];

// Buckets del data lake que el catálogo lista (solo lectura) para calcular
// tamaño/frescura. Los que viven en la cuenta hub 396913696127 requieren ADEMÁS
// una bucket policy del lado del hub (cross-account); ver scripts/grant-datalake-s3.sh.
// En cuenta APP (186): analytics-datafoundry-dev, arc-sandbox-desa.
// En cuenta HUB (396): el resto.
const DATA_LAKE_BUCKETS = [
  "arc-enterprise-data",
  "analytics-datafoundry-dev",
  "arc-sandbox-desa",
  "da-sandboxenv",
  "arc-sandbox-dev",
  "arc-archtest-tokenized",
  "da-data-geolocation",
  "arc-ingestioncontrol",
  "arc-enterprise-data-security",
  "aws-bdr-s3-datasync-destino",
];

export class GestionProyectosStack extends Stack {
  constructor(scope: Construct, id: string, props: GestionProyectosStackProps) {
    super(scope, id, props);

    const resourcePrefix = `${props.appName}-${props.envName}`;
    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `${resourcePrefix}-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, "FrontendOai", {
      comment: `${resourcePrefix} frontend access`
    });
    frontendBucket.grantRead(originAccessIdentity);

    const distribution = new cloudfront.Distribution(this, "FrontendDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: new origins.S3Origin(frontendBucket, { originAccessIdentity }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(5)
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(5)
        }
      ]
    });

    const callbackUrls = [
      "http://localhost:4321/",
      `https://${distribution.distributionDomainName}/`
    ];

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${resourcePrefix}-users`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true }
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const domainPrefix = `${resourcePrefix}-${this.account}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const userPoolDomain = userPool.addDomain("UserPoolDomain", {
      cognitoDomain: { domainPrefix }
    });

    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: `${resourcePrefix}-web`,
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE
        ],
        callbackUrls,
        logoutUrls: callbackUrls
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(1)
    });

    new cognito.CfnUserPoolUser(this, "InitialUser", {
      userPoolId: userPool.userPoolId,
      username: props.initialUserEmail,
      userAttributes: [
        { name: "email", value: props.initialUserEmail },
        { name: "email_verified", value: "true" }
      ],
      desiredDeliveryMediums: ["EMAIL"],
      forceAliasCreation: false
    });

    const table = new dynamodb.Table(this, "MainTable", {
      tableName: `${resourcePrefix}-main`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      // Usado por los mensajes de chat (Apoyo técnico) para expirar solos tras
      // MESSAGE_TTL_DAYS (services/chat.py); el resto de ítems no setea `ttl`,
      // así que no les afecta.
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY
    });
    // GSI por tipo de entidad: los listados globales (personas, proyectos, tareas,
    // usuarios de admin) consultan SOLO sus items en vez de escanear la tabla
    // completa — con la tabla creciendo (items ATHENA#EXEC del monitoreo), un scan
    // filtrado lee megas para devolver kilobytes. PAY_PER_REQUEST: sin capacity.
    table.addGlobalSecondaryIndex({
      indexName: "byEntityType",
      partitionKey: { name: "entityType", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const seedTimestamp = "2026-06-05T00:00:00.000Z";
    const initialUserId = props.initialUserEmail.trim().toLowerCase();
    new cr.AwsCustomResource(this, "InitialDataSeed", {
      onCreate: {
        service: "DynamoDB",
        action: "batchWriteItem",
        parameters: {
          RequestItems: {
            [table.tableName]: [
              {
                PutRequest: {
                  Item: {
                    PK: { S: `USER#${initialUserId}` },
                    SK: { S: "PROFILE" },
                    entityType: { S: "USER" },
                    email: { S: initialUserId },
                    name: { S: initialUserId },
                    status: { S: "active" },
                    roles: { L: [{ S: "admin" }, { S: "user" }] },
                    createdAt: { S: seedTimestamp },
                    updatedAt: { S: seedTimestamp }
                  }
                }
              },
              ...MODULES.map((moduleKey) => ({
                PutRequest: {
                  Item: {
                    PK: { S: `USER#${initialUserId}` },
                    SK: { S: `MODULE#${moduleKey}` },
                    entityType: { S: "USER_MODULE" },
                    moduleKey: { S: moduleKey },
                    label: { S: moduleLabel(moduleKey) },
                    enabled: { BOOL: true },
                    createdAt: { S: seedTimestamp },
                    updatedAt: { S: seedTimestamp }
                  }
                }
              })),
              {
                PutRequest: {
                  Item: {
                    PK: { S: "SETTING#APP" },
                    SK: { S: "META" },
                    entityType: { S: "SETTING" },
                    environment: { S: props.envName },
                    createdAt: { S: seedTimestamp },
                    updatedAt: { S: seedTimestamp }
                  }
                }
              }
            ]
          }
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${resourcePrefix}-initial-data-${initialUserId}`)
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [table.tableArn]
      }),
      installLatestAwsSdk: false
    });

    // Rol de ejecución de la Lambda. Dos modos:
    //  - prod (cuenta gobernada): se importa un rol pre-creado por el admin vía
    //    `apiRoleArn`; CDK no toca IAM (el deploy no necesita permisos de IAM).
    //  - dev: el stack crea el rol con NOMBRE ESTABLE y todos sus permisos en
    //    código (DynamoDB, logs, Glue read-only, auto-invocación). El nombre fijo
    //    da un ARN estable para grants externos (bucket policies, Lake Formation)
    //    y elimina la deriva de configuración (permisos puestos a mano).
    const functionName = `${resourcePrefix}-api`;
    const functionArn = `arn:aws:lambda:${this.region}:${this.account}:function:${functionName}`;
    const importedRole = props.apiRoleArn
      ? iam.Role.fromRoleArn(this, "ApiFunctionRole", props.apiRoleArn, { mutable: false })
      : undefined;

    const ownedRole = importedRole
      ? undefined
      : new iam.Role(this, "ApiFunctionRole", {
          roleName: `${resourcePrefix}-api-role`,
          assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
          description: "Rol de ejecución de la API de Gestión de Proyectos",
        });

    // ── Fuente ÚNICA de cuentas del dashboard de costos (módulo Inicio) ────────
    // De aquí se derivan: la env var COST_ACCOUNTS que lee el backend (whitelist +
    // routing) y los permisos sts:AssumeRole del rol de la Lambda. El selector del
    // frontend también se arma desde esta lista (vía GET /api/home/cost-accounts).
    //
    // Para AGREGAR una cuenta nueva:
    //   1) En la cuenta nueva, crear el rol cross-account de lectura de Cost
    //      Explorer con scripts/grant-hub-cost-explorer.sh (ajustando ACCOUNT_ID).
    //   2) Agregar una entrada en esta lista (mode "assume" + roleArn).
    //   3) cdk deploy.
    // mode "direct" = Cost Explorer de la propia cuenta de la Lambda (sin asumir
    // rol); mode "assume" = otra cuenta vía sts:AssumeRole a roleArn.
    const costAccounts: { id: string; name: string; mode: "direct" | "assume"; roleArn?: string }[] = [
      { id: this.account, name: "aws-bdr-cta-analitica-fab-datos-desa", mode: "direct" },
      {
        id: "396913696127",
        name: "aws-bdr-cta-analitica-fab-datos-prod",
        mode: "assume",
        roleArn: "arn:aws:iam::396913696127:role/gestion-proyectos-cost-reader",
      },
    ];
    const assumeCostRoleArns = costAccounts
      .filter((a) => a.mode === "assume" && a.roleArn)
      .map((a) => a.roleArn!);

    if (ownedRole) {
      ownedRole.addToPolicy(new iam.PolicyStatement({
        sid: "Logs",
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"],
      }));
      // Glue de SOLO LECTURA (metadata del data lake): nunca escribe ni borra.
      ownedRole.addToPolicy(new iam.PolicyStatement({
        sid: "GlueReadOnly",
        actions: ["glue:GetDatabases", "glue:GetDatabase", "glue:GetTables", "glue:GetTable", "glue:GetPartitions"],
        resources: ["*"],
      }));
      // Auto-invocación asíncrona para el sync global del catálogo.
      ownedRole.addToPolicy(new iam.PolicyStatement({
        sid: "SelfInvokeAsyncSync",
        actions: ["lambda:InvokeFunction"],
        resources: [functionArn],
      }));
      // S3 de SOLO LECTURA sobre los buckets del data lake (tamaño/frescura).
      // Lado app del acceso cross-account: el lado hub (bucket policy) lo aplica
      // el dueño del bucket en la cuenta 396913696127.
      ownedRole.addToPolicy(new iam.PolicyStatement({
        sid: "DataLakeS3ReadOnly",
        actions: ["s3:ListBucket", "s3:GetBucketLocation"],
        resources: DATA_LAKE_BUCKETS.map(b => `arn:aws:s3:::${b}`),
      }));
      // Cost Explorer de la cuenta app (solo lectura) para el dashboard de Inicio.
      ownedRole.addToPolicy(new iam.PolicyStatement({
        sid: "CostExplorerReadOnly",
        actions: ["ce:GetCostAndUsage", "ce:GetCostForecast", "ce:GetDimensionValues", "ce:GetTags", "ce:ListCostAllocationTags"],
        resources: ["*"],
      }));
      // CloudTrail (solo lectura) para el panel de "Responsables" de facturación
      // en la cuenta app. Para el hub se usa el rol cross-account (ver script).
      ownedRole.addToPolicy(new iam.PolicyStatement({
        sid: "CloudTrailLookup",
        actions: ["cloudtrail:LookupEvents"],
        resources: ["*"],
      }));
      // Identity Center (solo lectura): resolver el nombre real de los usuarios que
      // consultan Athena (monitoreo). El Identity Store vive en la cuenta de la app.
      ownedRole.addToPolicy(new iam.PolicyStatement({
        sid: "IdentityStoreReadOnly",
        actions: ["identitystore:GetUserId", "identitystore:DescribeUser"],
        resources: ["*"],
      }));
      // AssumeRole a los roles cross-account de Cost Explorer (cuentas "assume").
      // Cada rol lo crea scripts/grant-hub-cost-explorer.sh en su cuenta.
      if (assumeCostRoleArns.length) {
        ownedRole.addToPolicy(new iam.PolicyStatement({
          sid: "AssumeCostRoles",
          actions: ["sts:AssumeRole"],
          resources: assumeCostRoleArns,
        }));
      }
    }

    const apiFunction = new lambda.Function(this, "ApiFunction", {
      functionName,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset("../backend/app"),
      // 10s basta para las llamadas síncronas de la API (API Gateway corta a 29s
      // de todos modos), pero los workers async (sync del catálogo, escaneo de
      // Athena, respuestas del chat) corren en esta misma función: necesitan
      // presupuesto amplio o mueren a media ejecución dejando estados colgados
      // ("syncing"/"scanning"). El escaneo de Athena con ~3000 consultas llegó a
      // 300s → 600s de margen. La memoria manda el CPU en Lambda: el escaneo es
      // CPU-bound (parseo sqlglot por consulta), 1024 MB ≈ el doble de rápido por
      // prácticamente el mismo costo (mitad de duración a tarifa doble); 1792 MB
      // = 1 vCPU completo, el punto óptimo para este workload de parseo.
      timeout: Duration.seconds(600),
      memorySize: 1792,
      logRetention: logs.RetentionDays.ONE_MONTH,
      role: importedRole ?? ownedRole,
      environment: {
        ENV_NAME: props.envName,
        MAIN_TABLE_NAME: table.tableName,
        DEFAULT_MODULES: MODULES.join(","),
        // Fuente única de cuentas de costos (ver costAccounts arriba).
        COST_ACCOUNTS: JSON.stringify(costAccounts)
      }
    });

    // DynamoDB de la app: RW solo cuando el stack es dueño del rol (dev). Con rol
    // importado (prod) este permiso lo provee el admin en el rol pre-creado.
    if (ownedRole) {
      table.grantReadWriteData(ownedRole);
    }

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${resourcePrefix}-api`,
      corsPreflight: {
        allowHeaders: ["Authorization", "Content-Type"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS
        ],
        allowOrigins: [
          "http://localhost:4321",
          `https://${distribution.distributionDomainName}`
        ],
        maxAge: Duration.hours(1)
      }
    });

    const integration = new integrations.HttpLambdaIntegration("ApiIntegration", apiFunction);
    const jwtAuthorizer = new authorizers.HttpUserPoolAuthorizer("JwtAuthorizer", userPool, {
      userPoolClients: [userPoolClient]
    });

    httpApi.addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration
    });

    // Catch-all autenticado: UNA sola ruta para todo /api/* (el router interno de
    // la Lambda resuelve cada endpoint). Evita que el resource policy del Lambda
    // crezca con cada ruta (límite duro de 20KB de AWS). /health queda público.
    httpApi.addRoutes({
      path: "/api/{proxy+}",
      // Métodos explícitos (sin OPTIONS: el preflight CORS lo maneja corsPreflight).
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE
      ],
      integration,
      authorizer: jwtAuthorizer
    });

    new CfnOutput(this, "FrontendUrl", {
      value: `https://${distribution.distributionDomainName}/`
    });
    new CfnOutput(this, "ApiUrl", {
      value: httpApi.url ?? ""
    });
    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId
    });
    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId
    });
    new CfnOutput(this, "CognitoDomain", {
      value: userPoolDomain.domainName
    });
    new CfnOutput(this, "MainTableName", {
      value: table.tableName
    });
    new CfnOutput(this, "FrontendBucketName", {
      value: frontendBucket.bucketName
    });
    new CfnOutput(this, "DistributionId", {
      value: distribution.distributionId
    });
    new CfnOutput(this, "InitialUserEmail", {
      value: props.initialUserEmail
    });
  }
}

function moduleLabel(moduleKey: string): string {
  // Etiquetas del seed inicial (solo stacks nuevos). Las vigentes las impone el
  // manifiesto backend (services/users.py::_CURRENT_LABELS) sobre lo guardado.
  const labels: Record<string, string> = {
    home: "Panel",
    projects: "Solicitudes",
    tasks: "Tareas",
    catalog: "Catálogo",
    admin: "Administración"
  };
  return labels[moduleKey] ?? moduleKey;
}
