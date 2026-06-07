import { Duration, CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "@aws-cdk/aws-apigatewayv2-alpha";
import * as authorizers from "@aws-cdk/aws-apigatewayv2-authorizers-alpha";
import * as integrations from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
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
}

const MODULES = ["home", "projects", "tasks", "catalog", "admin"];

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
      removalPolicy: RemovalPolicy.DESTROY
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

    const apiFunction = new lambda.Function(this, "ApiFunction", {
      functionName: `${resourcePrefix}-api`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "handler.handler",
      code: lambda.Code.fromAsset("../backend/app"),
      timeout: Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        ENV_NAME: props.envName,
        MAIN_TABLE_NAME: table.tableName,
        DEFAULT_MODULES: MODULES.join(",")
      }
    });
    table.grantReadWriteData(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      resources: ["*"]
    }));

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
    httpApi.addRoutes({
      path: "/api/me",
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/workspace",
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/people",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/people/{personId}",
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/projects",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/projects/{projectId}",
      methods: [apigwv2.HttpMethod.PATCH],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/projects/{projectId}/members",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/projects/{projectId}/members/{personId}",
      methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/projects/{projectId}/tasks",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: jwtAuthorizer
    });
    httpApi.addRoutes({
      path: "/api/projects/{projectId}/tasks/{taskId}",
      methods: [apigwv2.HttpMethod.PATCH],
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
  const labels: Record<string, string> = {
    home: "Inicio",
    projects: "Proyectos",
    tasks: "Tareas",
    catalog: "Catálogo",
    admin: "Administración"
  };
  return labels[moduleKey] ?? moduleKey;
}
