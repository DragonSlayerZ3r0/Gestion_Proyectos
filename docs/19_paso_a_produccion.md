# Paso a producción (cuenta AWS separada)

Manual para desplegar la plataforma en una cuenta de producción distinta de `dev` (`186281981036`). La infraestructura CDK está parametrizada por ambiente: todos los nombres derivan del prefijo `{appName}-{envName}` y producción crea recursos exclusivos de Cognito, DynamoDB, S3, Lambda y API Gateway.

## 1. Campos a definir antes de empezar

Estos valores determinan dónde se ubicará todo. Completar esta tabla es el primer paso; el resto del manual los referencia como `<asi>`.

### Decisiones (los define el equipo)

| Campo | Descripción | Dónde se usa | Ejemplo |
| --- | --- | --- | --- |
| `<CUENTA_PROD>` | ID de la cuenta AWS de producción | Bootstrap, perfil SSO, grants Lake Formation | `999999999999` |
| `<REGION>` | Región de despliegue | Bootstrap y deploy. Hoy todo asume `us-east-1` | `us-east-1` |
| `<PERFIL_SSO_PROD>` | Nombre del perfil SSO local para la cuenta prod | `~/.aws/config`, todos los comandos `--profile` | `gestion-proyectos-prod` |
| `<ENV_NAME>` | Nombre del ambiente (contexto CDK `envName`) | Prefijo de TODOS los recursos | `prod` |
| `<APP_NAME>` | Nombre de la app (contexto CDK `appName`) | Prefijo de recursos. Mantener el default salvo razón fuerte | `gestion-proyectos` |
| `<CORREO_INICIAL>` | Correo del primer usuario funcional (contexto `initialUserEmail`) | Seed de Cognito + DynamoDB al desplegar | `admin@banrural.com.gt` |
| `<DOMINIO_PROPIO>` | (Opcional) Dominio público del frontend + certificado ACM | CloudFront alias. Si no se define, queda `*.cloudfront.net` | `gestion.banrural.com.gt` |
| `<ARN_ROL_PROD>` | ARN del rol de ejecución de la Lambda pre-creado por el admin (sección 2.1) | `--context apiRoleArn=...` en synth/deploy | `arn:aws:iam::<CUENTA_PROD>:role/gp-prod-api` |
| `<CUENTA_HUB>` | Cuenta del data lake hub para grants Lake Formation (solo si el data lake está en otra cuenta; si vive en prod, no aplica) | Permisos Glue/LF hacia el rol Lambda de prod | `396913696127` |

### Derivados (los genera CDK automáticamente a partir de los anteriores)

| Recurso | Nombre resultante con `envName=prod` |
| --- | --- |
| Stack CloudFormation | `GestionProyectosProdStack` (derivado de `envName`) |
| Bucket frontend | `gestion-proyectos-prod-frontend-<CUENTA_PROD>` |
| Cognito User Pool | `gestion-proyectos-prod-users` (ID `us-east-1_xxxx` lo asigna AWS) |
| Cognito App Client | `gestion-proyectos-prod-web` (ID lo asigna AWS) |
| Dominio Cognito | `gestion-proyectos-prod-<CUENTA_PROD>` |
| Tabla DynamoDB | `gestion-proyectos-prod-main` |
| Lambda | `gestion-proyectos-prod-api` |
| API Gateway | `gestion-proyectos-prod-api` (URL la asigna AWS) |
| Log group | `/aws/lambda/gestion-proyectos-prod-api` |

Los IDs/URLs que asigna AWS (pool, client, API URL, distribución CloudFront) salen como **outputs del stack** al final del deploy: anotarlos en `docs/15_estado_implementacion.md` (o su equivalente prod) y usarlos para el `config.json`.

### Campos del `config.json` de producción

El frontend lee su configuración en runtime desde `/config.json`, publicado de forma independiente al build. Para prod se construye con los outputs del stack:

```json
{
  "environment": "prod",
  "region": "<REGION>",
  "apiBaseUrl": "https://<API_ID>.execute-api.<REGION>.amazonaws.com/",
  "cognitoUserPoolId": "<POOL_ID_PROD>",
  "cognitoClientId": "<CLIENT_ID_PROD>"
}
```

`apiBaseUrl` debe terminar en `/`. Este archivo se sube al bucket prod por separado y **ningún deploy de frontend debe pisarlo** (sync con `--exclude config.json`).

**De dónde sale cada valor** (los imprime el `cdk deploy` al final, sección "Outputs"):

| Valor que necesitas | Output del stack | Se usa en |
| --- | --- | --- |
| `<API_ID>` (parte de `apiBaseUrl`) | `ApiUrl` | `config.json` |
| `<POOL_ID_PROD>` | `UserPoolId` | `config.json` |
| `<CLIENT_ID_PROD>` | `UserPoolClientId` | `config.json` |
| `<DIST_ID_PROD>` | `DistributionId` | invalidación CloudFront (paso 4.4) |
| URL del frontend | `FrontendUrl` | verificación / compartir |
| Nombre del bucket | `FrontendBucketName` | subida del frontend (paso 4) |

## 2. Ajustes de código previos (una sola vez)

1. **ID del stack** — HECHO. `infra/bin/gestion-proyectos.ts` deriva el ID del ambiente: dev → `GestionProyectosDevStack` (igual que antes), prod → `GestionProyectosProdStack`.
2. **Rol de la Lambda en cuenta gobernada** — HECHO. El stack acepta `apiRoleArn` por contexto. Si se pasa, consume un rol pre-creado por el admin (sin tocar IAM en el deploy); si se omite (dev), crea el rol como siempre. Ver sección 2.1.
3. **Script de deploy** en `infra/package.json`: `deploy` tiene `--profile gestion-proyectos-dev` fijo. Agregar `deploy:prod` con `--context envName=prod --profile <PERFIL_SSO_PROD>` (y considerar quitar `--require-approval never` en prod). PENDIENTE.
4. **Políticas de retención**: en dev conviene `RemovalPolicy.DESTROY`; en prod la tabla DynamoDB y el bucket frontend deben ser `RETAIN`, con PITR en la tabla. Condicionar por `envName`. PENDIENTE.
5. **Protección del stack**: `terminationProtection: true` cuando `envName === "prod"`. PENDIENTE.

### 2.1 Estrategia de IAM en cuenta de producción gobernada

En dev, el stack crea el rol de ejecución con nombre estable (`gestion-proyectos-dev-api-role`) y todos sus permisos en código (DynamoDB RW, logs, Glue read-only, auto-invocación) — ya no hay drift. En la cuenta de producción (donde vive el data lake y hay SCPs/permission boundaries), la identidad de despliegue normalmente **no puede gestionar IAM**, así que el patrón es: **el admin pre-crea el rol de ejecución** con esa misma política y se pasa su ARN por contexto (`--context apiRoleArn=...`); el stack lo consume sin crear ni modificar IAM.

**Política mínima (solo lectura sobre el data lake) que el admin debe asignar a ese rol:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AppDynamoDB",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem","dynamodb:Query","dynamodb:BatchWriteItem"],
      "Resource": "arn:aws:dynamodb:<REGION>:<CUENTA_PROD>:table/gestion-proyectos-prod-main"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
      "Resource": "arn:aws:logs:<REGION>:<CUENTA_PROD>:*"
    },
    {
      "Sid": "GlueReadOnly",
      "Effect": "Allow",
      "Action": ["glue:GetDatabases","glue:GetDatabase","glue:GetTables","glue:GetTable","glue:GetPartitions"],
      "Resource": "*"
    },
    {
      "Sid": "SelfInvokeAsyncSync",
      "Effect": "Allow",
      "Action": ["lambda:InvokeFunction"],
      "Resource": "arn:aws:lambda:<REGION>:<CUENTA_PROD>:function:gestion-proyectos-prod-api"
    }
  ]
}
```

- **Solo lectura** sobre Glue y el Data Lake. La aplicación escribe datos operativos únicamente en su tabla DynamoDB.
- `lambda:InvokeFunction` sobre sí misma: la usa el sync global asíncrono (`POST /api/catalog/sync` se auto-invoca).
- Si Lake Formation está *enforced* sobre esas bases, además hay que otorgar al rol grants `DESCRIBE`/`SELECT` de lectura desde Lake Formation (no basta la política IAM).
- El rol debe confiar en `lambda.amazonaws.com` (trust policy) y respetar el permission boundary que exija la organización.

> **Permisos del lado del hub:** el rol cross-account `gestion-proyectos-cost-reader` necesita, además de Cost Explorer + CloudTrail, una política Athena/Glue/S3 y un grant de Lake Formation (registros del data lake + monitoreo de Athena). El set COMPLETO por feature y los tres mecanismos están en **[permisos_hub.md](permisos_hub.md)**. Todo eso debe repetirse apuntando al ARN del rol de prod.

**Acceso S3 al data lake (para tamaño/frescura de tablas):** requiere DOS lados, porque los buckets del lake viven en la cuenta hub `396913696127` (cross-account):
- *Lado app (cuenta del rol):* `s3:ListBucket` + `s3:GetBucketLocation` sobre los buckets del lake. **En dev ya está en CDK** (constante `DATA_LAKE_BUCKETS` en el rol del stack; aplica tras `infra:deploy`). En prod, el admin lo incluye en el rol pre-creado.
- *Lado hub (dueño del bucket):* fusionar una sentencia de solo lectura dentro de la *bucket policy* existente y preservar todas sus sentencias actuales. Script: `scripts/grant-datalake-s3.sh <bucket> <role_arn> [perfil]`, o el comando manual equivalente. Debe correrse **después** de que el rol exista (S3 rechaza principals inexistentes) con un perfil admin del hub. Nota: `admin_dl` es un rol/usuario IAM dentro de `396913696127`; el perfil CLI para esa cuenta es `bdr-fed`.

**Nota — otros roles que el stack crea (CDK helpers):** además del rol de la Lambda, CDK provisiona roles para `logRetention` y para el custom resource del seed inicial. En una cuenta muy bloqueada estos también podrían requerir que el admin permita su creación, o reemplazarlos (LogGroup explícito en vez de `logRetention`; correr el seed manualmente). Validar con el equipo de plataforma antes del primer deploy.

## 3. Procedimiento de despliegue

**Antes de empezar:**
- Tener el repo clonado con dependencias instaladas: `npm install` en la raíz (instala `frontend` e `infra`).
- Node 20+, `pnpm` y AWS CLI v2 disponibles.
- Aplicar primero los ajustes PENDIENTE de la sección 2 (3, 4 y 5) si quieres protección de producción (`RETAIN`, `terminationProtection`, script `deploy:prod`). No son obligatorios para que el deploy funcione, pero sí recomendados para prod; si los omites, el stack usa los valores por defecto de dev.
- En todos los comandos, reemplaza los `<PLACEHOLDER>` por los valores que definiste en la tabla de la sección 1.

**3.0 Crear el perfil SSO** en `~/.aws/config` (una vez). Ejemplo del bloque a añadir (ver [docs/16_credenciales_aws_sso.md](16_credenciales_aws_sso.md) para los valores de la organización):

```ini
[profile <PERFIL_SSO_PROD>]
sso_session = bdr-fed
sso_account_id = <CUENTA_PROD>
sso_role_name = <ROL_SSO_QUE_TE_ASIGNARON>
region = <REGION>
output = json
```

```bash
# 3.1 Login y verificación de que apuntas a la cuenta correcta
aws sso login --profile <PERFIL_SSO_PROD>
aws sts get-caller-identity --profile <PERFIL_SSO_PROD>   # debe mostrar <CUENTA_PROD>

# 3.2 Bootstrap CDK en la cuenta/región prod (una sola vez)
cd infra
npx cdk bootstrap aws://<CUENTA_PROD>/<REGION> --profile <PERFIL_SSO_PROD>

# 3.3 (Admin) Pre-crear el rol de ejecución de la Lambda con la política mínima
#     de la sección 2.1 y obtener su ARN: arn:aws:iam::<CUENTA_PROD>:role/<rol>

# 3.4 Validar síntesis sin desplegar
npx cdk synth --context envName=prod --context apiRoleArn=<ARN_ROL_PROD>

# 3.5 Desplegar (crea TODOS los recursos prod, incluye backend Lambda y seed)
npx cdk deploy --context envName=prod \
  --context apiRoleArn=<ARN_ROL_PROD> \
  --context initialUserEmail=<CORREO_INICIAL> \
  --profile <PERFIL_SSO_PROD>
# Anotar los outputs: bucket, distribución, API URL, pool, client
```

## 4. Publicar el frontend en prod

```bash
# 4.1 Construir
cd frontend && pnpm build

# 4.2 Crear config.json prod (sección 1) p.ej. en /tmp/config-prod.json y subirlo
aws s3 cp /tmp/config-prod.json s3://gestion-proyectos-prod-frontend-<CUENTA_PROD>/config.json \
  --cache-control no-store --profile <PERFIL_SSO_PROD>

# 4.3 Sincronizar el build SIN pisar config.json
aws s3 sync dist/ s3://gestion-proyectos-prod-frontend-<CUENTA_PROD>/ \
  --delete --exclude config.json --profile <PERFIL_SSO_PROD>

# 4.4 Invalidar CloudFront
aws cloudfront create-invalidation --distribution-id <DIST_ID_PROD> \
  --paths "/*" --profile <PERFIL_SSO_PROD>
```

## 5. Inicialización de datos y accesos en producción

- **Usuarios Cognito**: prod arranca con `<CORREO_INICIAL>` y cambio de contraseña inicial. Los demás usuarios se crean expresamente desde Administración o por CLI para mantener separadas las identidades de cada ambiente.
- **DynamoDB**: arranca vacía (salvo el seed). Decidir explícitamente si prod inicia limpio (recomendado) o si se migra algo de dev con export/import de DynamoDB.
- **Catálogo**: ejecutar el sync (`POST /api/catalog/sync`) una vez haya permisos sobre Glue en prod.
- **Lake Formation / Glue del hub**: producción requiere grants propios hacia `<CUENTA_PROD>`, resource links en la cuenta prod y permiso `DESCRIBE` sobre esos links para el rol Lambda prod. Gestionarlo con anticipación (ver `docs/07_catalogo_datalake.md`, sección "Visibilidad pendiente").

## 6. Deseable para producción (no bloqueante)

- `<DOMINIO_PROPIO>` con certificado ACM (en `us-east-1` para CloudFront) y alias en la distribución.
- Alarmas CloudWatch: errores 5xx de API/Lambda, throttling de DynamoDB.
- Retención de logs y revisión de costos (presupuesto/Budget en la cuenta).
- WAF en CloudFront/API si la política de la organización lo exige.

## 7. Checklist final

- [ ] Tabla de campos de la sección 1 completada y acordada.
- [ ] Ajustes de código de la sección 2 aplicados y validados con `npm run check`.
- [ ] Bootstrap hecho en `<CUENTA_PROD>`.
- [ ] Stack prod desplegado y outputs anotados.
- [ ] `config.json` prod subido y verificado (`curl https://<dominio>/config.json`).
- [ ] Frontend publicado e invalidado; login con `<CORREO_INICIAL>` funciona.
- [ ] Grants Lake Formation solicitados/aplicados para el rol Lambda prod.
- [ ] Sync de catálogo ejecutado y módulos visibles según permisos.
- [ ] Documentación actualizada: recursos prod registrados (equivalente a `docs/15_estado_implementacion.md`) y `AGENTS.md` si cambia la regla de perfiles.
