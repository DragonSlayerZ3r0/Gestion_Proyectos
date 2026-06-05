# Integraciones AWS

El perfil operativo validado para iniciar construccion esta documentado en `docs/14_permisos_aws_actuales.md`. Ese archivo resume cuenta, rol, servicios probados, permisos inferidos y limitantes actuales.

## Cognito

- Uso: autenticacion de usuarios.
- Permisos IAM: configuracion administrada fuera de Lambda salvo necesidades especificas.
- Variables: `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_DOMAIN`.
- Consideraciones: no mezclar autenticacion con autorizacion funcional.

## DynamoDB

- Uso: datos operativos, permisos, contexto funcional y auditoria.
- Permisos IAM: `GetItem`, `PutItem`, `UpdateItem`, `Query`, `DeleteItem` cuando aplique.
- Variables: `MAIN_TABLE_NAME`.
- Consideraciones: disenar claves segun patrones de consulta.

## Glue Catalog

- Uso: metadata tecnica de Data Lake.
- Permisos IAM: `glue:GetDatabases`, `glue:GetTables`, `glue:GetTable`, `glue:GetPartitions` si aplica.
- Variables: `GLUE_CATALOG_ID` opcional.
- Consideraciones: Glue no guarda contexto funcional de negocio.

## Athena

- Uso: preview y consultas controladas.
- Permisos IAM: `athena:StartQueryExecution`, `athena:GetQueryExecution`, `athena:GetQueryResults`.
- Variables: `ATHENA_WORKGROUP`, `ATHENA_OUTPUT_LOCATION`.
- Consideraciones: no permitir SQL libre desde frontend.

## S3

- Uso: frontend estatico privado, Data Lake y resultados Athena.
- Permisos IAM: segun bucket y funcion.
- Variables: `DATA_LAKE_BUCKET`, `ATHENA_OUTPUT_BUCKET`.
- Consideraciones: no usar buckets publicos para el frontend; servir por CloudFront.

## CloudWatch

- Uso: logs y metricas.
- Permisos IAM: permisos basicos de Lambda para logs.
- Variables: nivel de logging si aplica.
- Consideraciones: no registrar secretos ni datos sensibles innecesarios.

## IAM

- Uso: permisos entre servicios.
- Consideraciones: usar minimo privilegio y separar permisos por ambiente.

## Lake Formation opcional

- Uso: control avanzado de acceso a datos.
- Consideraciones: evaluarlo cuando el catalogo y preview requieran controles mas finos.
