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

- Uso: frontend estático privado, Data Lake y resultados Athena.
- Permisos IAM: según bucket y función.
- Variables: `DATA_LAKE_BUCKET`, `ATHENA_OUTPUT_BUCKET`.
- Consideraciones: CloudFront sirve el frontend desde un bucket privado mediante OAC.

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
