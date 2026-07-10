# Integraciones AWS

El perfil operativo validado para iniciar construcción está documentado en `docs/14_permisos_aws_actuales.md`. Ese archivo resume cuenta, rol, servicios probados, permisos inferidos y limitantes actuales.

## Cognito

- Uso: autenticación de usuarios.
- Permisos IAM: configuración administrada fuera de Lambda salvo necesidades específicas.
- Variables: `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`.
- Consideraciones: Cognito autentica; DynamoDB y Lambda resuelven la autorización funcional.

## DynamoDB

- Uso: datos operativos, permisos, contexto funcional y auditoría.
- Permisos IAM: `GetItem`, `PutItem`, `UpdateItem`, `Query`, `DeleteItem` cuando aplique.
- Variables: `MAIN_TABLE_NAME`.
- Consideraciones: diseñar claves según patrones de consulta.

## Glue Catalog

- Uso: metadata técnica de Data Lake.
- Permisos IAM: `glue:GetDatabases`, `glue:GetTables`, `glue:GetTable`, `glue:GetPartitions` si aplica.
- Variables: `GLUE_CATALOG_ID` opcional.
- Consideraciones: Glue guarda metadata técnica; DynamoDB guarda contexto funcional de negocio.

## Athena

- Uso: preview y consultas controladas.
- Permisos IAM: `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`.
- Variables: `ATHENA_WORKGROUP`, `ATHENA_OUTPUT_LOCATION`.
- Consideraciones: los servicios backend construyen y ejecutan consultas controladas.

## S3

- Uso: frontend estático privado (incl. `/vendor/` con librerías auto-hospedadas), Data Lake, resultados Athena y **storage compartido `gad-storage-<env>`** (adjuntos de solicitudes + escenas de Pizarra).
- Permisos IAM: según bucket y función; el storage compartido va **acotado al prefijo de la app** (`gestion-proyectos/*`) y se accede con URLs prefirmadas (el binario nunca pasa por la API).
- Variables: `DATA_LAKE_BUCKET`, `ATHENA_OUTPUT_BUCKET`, `ATTACHMENTS_BUCKET`, `ATTACHMENTS_PREFIX`.
- Consideraciones: CloudFront sirve el frontend desde un bucket privado mediante OAC; el storage es RETAIN (los archivos sobreviven a un destroy) con CORS solo al origen CloudFront.

## API Gateway WebSocket (colaboración en vivo, 2026-07-08)

- Uso: salas de tiempo real de Pizarra (`$connect`/`$disconnect`/`$default` sobre la misma Lambda).
- Permisos IAM: `execute-api:ManageConnections` en el rol de la Lambda (empujar mensajes con `post_to_connection`).
- Autenticación: sin authorizer JWT nativo — el access token de Cognito viaja como query param y `$connect` lo valida con `cognito-idp:GetUser` (autenticado por el propio token, no requiere permiso IAM).
- Variables: la URL sale del output `WebSocketUrl` → `config.json.wsUrl`.

## Bedrock (GLM 5)

- Uso: sugerencias SQL (Athena), chat de Apoyo técnico y estructuración de asuetos.
- Permisos IAM: `bedrock:InvokeModel`/`Converse` sobre `zai.glm-5` vía el rol del hub (AssumeRole). La SCP de la organización bloquea Claude/AgentCore por la vía clásica; desde 2026-07-09 Claude sí es invocable vía Bedrock Mantle (us-east-1) y GLM 5 se mantiene por decisión — detalle en `docs/permisos_hub.md` 1d.
- Consideraciones: en el chat la generación es asíncrona (la Lambda se auto-invoca; API Gateway corta a 29 s).

## Textract

- Uso: OCR de la publicación oficial de asuetos (2026-07-09). Pipeline: imagen reducida en el navegador → `DetectDocumentText` → GLM 5 estructura → borrador que el admin confirma (human-in-the-loop; nada se guarda automático).
- Permisos IAM: `textract:DetectDocumentText` en el rol de la Lambda (sid `TextractDetectText`).
- Consideraciones: la imagen viaja en el body (base64 <1 MB tras la reducción) — el límite de invocación síncrona de Lambda es 6 MB y se valida DEL LADO QUE ENVÍA (incidente 2026-07-09 en bitácora).

## CloudWatch

- Uso: logs y métricas.
- Permisos IAM: permisos básicos de Lambda para logs.
- Variables: nivel de logging si aplica.
- Consideraciones: los logs incluyen contexto operativo y excluyen secretos y datos sensibles.

## IAM

- Uso: permisos entre servicios.
- Consideraciones: usar mínimo privilegio y separar permisos por ambiente.

## Lake Formation opcional

- Uso: control avanzado de acceso a datos.
- Consideraciones: evaluarlo cuando el catálogo y preview requieran controles más finos.
