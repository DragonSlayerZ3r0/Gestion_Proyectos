# Permisos AWS actuales

## Perfil validado

- Perfil AWS CLI: `186281981036_aws-ps-admin-analitica-bdr`
- Cuenta: `186281981036`
- Region principal: `us-east-1`
- Rol asumido: `AWSReservedSSO_aws-ps-admin-analitica-bdr_f6f115306273af6d`
- ARN de sesion validado: `arn:aws:sts::186281981036:assumed-role/AWSReservedSSO_aws-ps-admin-analitica-bdr_f6f115306273af6d/usr041100@banrural.com.gt`

No guardar llaves, secretos ni tokens de sesion en este repositorio.

## Regla operativa de sesion

Para este proyecto, usar el perfil `186281981036_aws-ps-admin-analitica-bdr` salvo instruccion contraria.

Antes de ejecutar acciones AWS relevantes, validar la sesion con:

```bash
aws sts get-caller-identity --profile 186281981036_aws-ps-admin-analitica-bdr
```

Las credenciales son temporales. Si han pasado cerca de 8 horas desde la ultima renovacion, o si la validacion falla por expiracion del token, detener acciones AWS y solicitar al usuario un nuevo bloque de credenciales temporales con `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN`.

## Estado general

El perfil tiene permisos suficientes para iniciar la construccion de la plataforma en AWS. La cuenta ya tiene bootstrap de CDK mediante stack `CDKToolkit`, por lo que es viable desplegar infraestructura con CloudFormation/CDK si se mantiene el mismo perfil o uno equivalente.

## Servicios verificados por CLI

| Servicio | Resultado | Observacion |
| --- | --- | --- |
| STS | Correcto | Identidad validada contra la cuenta `186281981036`. |
| S3 | Correcto | Lista buckets existentes. |
| Lambda | Correcto | Lista funciones existentes en `us-east-1`. |
| API Gateway v2 | Correcto | Acceso de lectura validado; no habia APIs listadas. |
| DynamoDB | Correcto | Acceso de lectura validado; no habia tablas listadas en `us-east-1`. |
| Cognito | Correcto | Acceso de lectura validado; no habia user pools listados. |
| Glue Catalog | Correcto | Lista bases como `arc_dev`, `arc_sandbox_desa` y `default`. |
| Athena | Correcto | Workgroup `primary` habilitado. |
| CloudFormation | Correcto | Lista stacks, incluyendo `CDKToolkit`. |
| CloudWatch Logs | Correcto | Lista log groups existentes. |
| IAM | Correcto parcial | Permite leer rol y politicas; no permite simulacion IAM. |
| CloudFront | Correcto | Comando ejecutado sin error; no devolvio distribuciones en la pagina consultada. |

## Permisos inferidos del rol

La politica inline del rol SSO incluye permisos amplios sobre los servicios necesarios para la arquitectura:

- `s3:*`
- `lambda:*`
- `dynamodb:*`
- `glue:*`
- `athena:*`
- `apigateway:*`
- `cloudfront:*`
- `cognito-idp:*`
- `cognito-identity:*`
- `logs:*`
- `cloudwatch:*`
- `cloudformation:CreateStack`
- `cloudformation:UpdateStack`
- `cloudformation:DeleteStack`
- `cloudformation:ValidateTemplate`
- `iam:CreateRole`
- `iam:CreatePolicy`
- `iam:PutRolePolicy`
- `iam:AttachRolePolicy`
- `iam:PassRole`

Tambien tiene politicas administradas relacionadas con analitica y datos:

- `AmazonS3FullAccess`
- `AmazonAthenaFullAccess`
- `AWSGlueConsoleFullAccess`
- `AWSLakeFormationDataAdmin`
- `AmazonRedshiftFullAccess`
- `AmazonSageMakerFullAccess`
- `AWSSSOMemberAccountAdministrator`

## Limitantes encontradas

- No permite `iam:SimulatePrincipalPolicy`; por eso no se pudo generar una matriz exacta de allow/deny mediante simulador IAM.
- No permite `sts:GetAccessKeyInfo`; esto no bloquea el despliegue, solo limita esa verificacion puntual.
- Las credenciales del perfil son temporales porque usan access key `ASIA...`; validar vigencia al iniciar trabajo AWS y solicitar renovacion si han pasado cerca de 8 horas o el token ya expiro.
- La primera verificacion sin permisos escalados fallo al conectar con endpoints regionales por restriccion del entorno local/sandbox. Con ejecucion escalada, las llamadas AWS funcionaron.
- El custom resource `BucketDeployment` de CDK fallo al copiar assets desde el bucket bootstrap cifrado con SSE-KMS. La alternativa operativa vigente es desplegar infraestructura con CDK y publicar `frontend/dist` con `aws s3 sync`.

## Implicacion para la construccion

La fase inicial ya fue desplegada con estos servicios:

- S3 privado para frontend.
- CloudFront para distribucion.
- Cognito para autenticacion.
- API Gateway para API.
- Lambda Python para backend.
- DynamoDB para datos operativos, permisos y auditoria.
- Glue Catalog y Athena para catalogo Data Lake y preview controlado.
- CloudWatch Logs para observabilidad.
- IAM roles y politicas via CloudFormation/CDK.

Mantener nombres, prefijos, tags y estrategia de ambientes antes de agregar nuevos recursos para evitar colisiones con recursos existentes en la cuenta.
