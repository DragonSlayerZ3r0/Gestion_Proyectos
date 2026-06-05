# Instrucciones para agentes

Este proyecto debe construirse con contexto documental separado. No concentres todas las reglas en este archivo: usa `docs/` como fuente principal.

## Orden recomendado de lectura

1. `README.md`
2. `docs/00_contexto_general.md`
3. `docs/12_guardrails.md`
4. El documento especifico del modulo que se va a modificar.

Para trabajos que creen o validen infraestructura AWS, leer tambien `docs/14_permisos_aws_actuales.md` y `docs/16_credenciales_aws_sso.md`.

## Reglas generales

- Mantener la plataforma simple, clara y rápida.
- Todo texto visible para usuarios y documentación funcional debe estar en español. Mantener nombres técnicos de servicios, comandos, rutas, clases y variables en su forma técnica cuando corresponda.
- No construir una experiencia tipo Jira.
- Mantener la documentacion sincronizada con cambios reales.
- Separar autenticación de autorización.
- Validar permisos en backend, no solo ocultar elementos en frontend.
- No exponer credenciales AWS ni buckets S3 públicos.
- Usar DynamoDB para autorizacion funcional y datos operativos.
- Usar Glue Catalog como metadata técnica, no como fuente de contexto funcional.
- Usar Athena solo para consultas controladas o preview, no para CRUD.
- Para AWS, trabajar con el perfil SSO `gestion-proyectos-dev` salvo instrucción contraria.
- Antes de ejecutar acciones AWS relevantes, validar que la sesión siga vigente con STS; si SSO falla por expiración, solicitar al usuario ejecutar `aws sso login --sso-session bdr-fed`.
- No pedir ni pegar `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` ni `AWS_SESSION_TOKEN` para el flujo normal del proyecto.

## Documentos por tema

- Arquitectura: `docs/01_arquitectura_aws.md`
- Módulos: `docs/02_modulos_funcionales.md`
- Seguridad: `docs/03_seguridad_accesos.md`
- DynamoDB: `docs/04_modelo_dynamodb.md`
- Backend/API: `docs/05_api_backend.md`
- Frontend/UX: `docs/06_frontend_ux.md`
- Catálogo Data Lake: `docs/07_catalogo_datalake.md`
- Proyectos y tareas: `docs/08_proyectos_tareas.md`
- Administración: `docs/09_admin_accesos.md`
- Integraciones AWS: `docs/10_integraciones_aws.md`
- Fases: `docs/11_fases_implementacion.md`
- Backlog: `docs/13_backlog_inicial.md`
- Permisos AWS actuales: `docs/14_permisos_aws_actuales.md`
- Estado de implementación: `docs/15_estado_implementacion.md`
- Credenciales AWS SSO: `docs/16_credenciales_aws_sso.md`
