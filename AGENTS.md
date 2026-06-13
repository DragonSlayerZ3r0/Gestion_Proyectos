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
- El workspace usa `pnpm`. El flujo vigente de publicación de frontend está en `docs/17_desarrollo_local_publicacion.md` (build con `pnpm build`, `config.json` desde `/tmp/config-prod.json`, sync a S3 con `--exclude config.json` e invalidación CloudFront).

## Stack técnico (resumen para agentes)

- **Frontend**: Astro 6 estático con una sola página. Separación de responsabilidades: `frontend/src/pages/index.astro` es solo el cascarón HTML; la lógica de la SPA vive en `frontend/src/scripts/app.ts` (importado por el `<script>`) y los estilos globales en `frontend/src/styles/app.css` (importado en el frontmatter). No hay framework de componentes ni router; la navegación entre módulos es por estado en memoria (`state.activeModule`) renderizado imperativamente con `innerHTML` y listeners re-enlazados en cada render. `app.ts` aún es un módulo único grande con `@ts-nocheck` (pendiente: dividir por dominio — catálogo, workspace, grafo, auth). Verificar cambios con `pnpm build` dentro de `frontend/` (incluye `astro check`).
- **Dependencias frontend**: `@aws-sdk/client-cognito-identity-provider` (login directo contra Cognito: flujo `USER_PASSWORD_AUTH` + challenge `NEW_PASSWORD_REQUIRED`). D3 v7 no está en `package.json`: se carga bajo demanda desde `unpkg.com/d3@7` solo al abrir el grafo del catálogo.
- **Sesión**: tokens Cognito en `sessionStorage` (`gestionProyectosAuth`); módulo activo persistido en `gestionProyectosModule`. Configuración runtime en `/config.json` (se obtiene con `fetch` al arrancar; no forma parte del bundle).
- **Backend**: Lambda Python en `backend/app/` (handler + repositorios + servicios, sin framework web), expuesta vía API Gateway. Validar sintaxis con `npm run check:python` desde la raíz.
- **Infra**: CDK TypeScript en `infra/` (stack único `infra/lib/gestion-proyectos-stack.ts`); deploy con `npm run infra:deploy` (perfil SSO `gestion-proyectos-dev`).
- **Datos**: DynamoDB single-table (autorización funcional, datos operativos y caché del catálogo) + Glue Catalog (metadata técnica, sincronizada a DynamoDB).
- **Grafo del catálogo**: render en Canvas 2D con culling por viewport, LOD de etiquetas y picking por quadtree para escalar a miles de nodos (detalle en `docs/07_catalogo_datalake.md`). No reintroducir render SVG por nodo: se descartó por rendimiento con catálogos grandes.
- **Verificación completa**: `npm run check` en la raíz (build frontend + sintaxis Python + synth de CDK).

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
- Servicios AWS en contexto y comportamiento runtime: `docs/18_servicios_y_runtime.md`
- Paso a producción: `docs/19_paso_a_produccion.md`
