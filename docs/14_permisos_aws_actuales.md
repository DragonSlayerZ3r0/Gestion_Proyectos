# Permisos AWS actuales

> **Permisos del lado del hub (cuenta 396913696127)**: este documento cubre la
> cuenta de la app y Bedrock. Los permisos que el admin del hub debe otorgar
> (rol cross-account `gestion-proyectos-cost-reader`, bucket policies y grants de
> Lake Formation) están consolidados en **[permisos_hub.md](permisos_hub.md)** —
> ahí está el set COMPLETO por feature y lo que hay que repetir para prod.

## Perfil validado

- Perfil AWS CLI recomendado: `gestion-proyectos-dev`
- Perfil legacy usado inicialmente: `186281981036_aws-ps-admin-analitica-bdr`
- Cuenta: `186281981036`
- Region principal: `us-east-1`
- Rol asumido: `AWSReservedSSO_aws-ps-admin-analitica-bdr_f6f115306273af6d`
- ARN de sesión validado: `arn:aws:sts::186281981036:assumed-role/AWSReservedSSO_aws-ps-admin-analitica-bdr_f6f115306273af6d/usr041100@banrural.com.gt`

No guardar llaves, secretos ni tokens de sesión en este repositorio.

## Regla operativa de sesión

Para este proyecto, usar el perfil SSO `gestion-proyectos-dev` salvo instrucción contraria.

Antes de ejecutar acciones AWS relevantes, validar la sesión con:

```bash
aws sts get-caller-identity --profile gestion-proyectos-dev --region us-east-1 --no-cli-pager
```

Las credenciales son temporales y se renuevan mediante AWS IAM Identity Center. Si la validación falla por expiración del token, detener acciones AWS y solicitar al usuario ejecutar:

```bash
aws sso login --sso-session bdr-fed
```

No solicitar bloques de `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` ni `AWS_SESSION_TOKEN` salvo contingencia explícita.

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

## Bedrock (verificado 2026-06-12)

Verificación por CLI contra la cuenta `186281981036` en `us-east-1`, con invocaciones reales mínimas (`bedrock-runtime converse` / `invoke-model`).

### Embeddings: disponibles y funcionando

| Modelo | Resultado | Observación |
| --- | --- | --- |
| `amazon.titan-embed-text-v2:0` | Correcto | On-demand en us-east-1; vectores de 1024 dimensiones. |
| `cohere.embed-multilingual-v3` | Correcto | On-demand en us-east-1; vectores de 1024 dimensiones; entrenado multilingüe (mejor para español). |

Model access ya habilitado; no requiere pasos adicionales para usarlos desde Lambda (solo agregar `bedrock:InvokeModel` al rol de la Lambda sobre estos ARNs).

### Claude: bloqueado por SCP de la organización

- Los modelos Claude 4.x existen en us-east-1 pero solo se invocan vía perfiles de inferencia cross-region (`us.*` / `global.*`), que enrutan entre us-east-1, us-east-2 y us-west-2.
- La invocación fue denegada (3/3 intentos, enrutada a us-east-2) por una SCP del payer de la organización: cuenta `866174429827`, política `p-d6a8uuwd`, con deny explícito de `bedrock:InvokeModel` fuera de us-east-1.
- No existe variante on-demand de Claude 4.x limitada a us-east-1. Los Claude 3 legacy on-demand están bloqueados por el proveedor (sin uso en 30 días).
- Desbloqueo: requiere que el administrador de la organización agregue excepción a la SCP para `bedrock:InvokeModel` en us-east-2/us-west-2 (al menos sobre `foundation-model/anthropic.*`).

### Alternativas generativas on-demand en us-east-1 (verificadas)

Modelos que corren completamente dentro de us-east-1, sin cross-region, compatibles con la restricción regional de la institución:

| Modelo | Resultado | Observación |
| --- | --- | --- |
| `amazon.nova-pro-v1:0` | Correcto | Primera parte AWS; multilingüe; Converse API. |
| `mistral.mistral-large-3-675b-instruct` | Correcto | Multilingüe fuerte; Converse API. |
| `openai.gpt-oss-120b-1:0` | Correcto | Open-weight; devuelve bloques `reasoningContent` antes de la respuesta. |

También disponibles on-demand (no probados): `amazon.nova-lite-v1:0`, `amazon.nova-micro-v1:0`, `cohere.rerank-v3-5:0` (reranker, útil para mejorar la recuperación en RAG), `deepseek.v3.2`, `qwen.qwen3-next-80b-a3b`, `zai.glm-5`, entre otros.

Decisión de diseño recomendada: usar Converse API con el model id como configuración, de modo que si la SCP se ajusta en el futuro, cambiar a Claude sea solo un cambio de string.

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

- SCP de la organización deniega `bedrock:InvokeModel` fuera de us-east-1, lo que bloquea los modelos Claude 4.x (solo disponibles vía perfiles cross-region). Ver sección Bedrock.
- No permite `iam:SimulatePrincipalPolicy`; por eso no se pudo generar una matriz exacta de allow/deny mediante simulador IAM.
- No permite `sts:GetAccessKeyInfo`; esto no bloquea el despliegue, solo limita esa verificacion puntual.
- El perfil legacy `186281981036_aws-ps-admin-analitica-bdr` usa credenciales STS pegadas en `~/.aws/credentials`; se conserva solo como fallback temporal.
- El perfil recomendado `gestion-proyectos-dev` usa SSO y evita exponer llaves temporales en chat o archivos del repositorio.
- La primera verificacion sin permisos escalados fallo al conectar con endpoints regionales por restriccion del entorno local/sandbox. Con ejecucion escalada, las llamadas AWS funcionaron.
- El custom resource `BucketDeployment` de CDK fallo al copiar assets desde el bucket bootstrap cifrado con SSE-KMS. La alternativa operativa vigente es desplegar infraestructura con CDK y publicar `frontend/dist` con `aws s3 sync`.

## Implicacion para la construccion

La fase inicial ya fue desplegada con estos servicios:

- S3 privado para frontend.
- CloudFront para distribucion.
- Cognito para autenticacion.
- API Gateway para API.
- Lambda Python para backend.
- DynamoDB para datos operativos, permisos y auditoría.
- Glue Catalog y Athena para catálogo Data Lake y preview controlado.
- CloudWatch Logs para observabilidad.
- IAM roles y politicas via CloudFormation/CDK.

Mantener nombres, prefijos, tags y estrategia de ambientes antes de agregar nuevos recursos para evitar colisiones con recursos existentes en la cuenta.
