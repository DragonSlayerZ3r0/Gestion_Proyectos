# Instrucciones para agentes

Este proyecto utiliza contexto documental separado. `AGENTS.md` define reglas transversales y `docs/` constituye la fuente principal de contexto funcional, técnico y operativo.

## Orden recomendado de lectura

1. `README.md`
2. `docs/00_contexto_general.md`
3. `docs/12_guardrails.md`
4. `docs/22_bitacora.md` — cómo llegó el proyecto a su estado actual (decisiones, incidentes, cambios de rumbo).
5. El documento especifico del modulo que se va a modificar.

Para trabajos que creen o validen infraestructura AWS, leer tambien `docs/14_permisos_aws_actuales.md` y `docs/16_credenciales_aws_sso.md`.

## Reglas generales

- Mantener la plataforma simple, clara y rápida.
- Todo texto visible para usuarios y documentación funcional debe estar en español. Mantener nombres técnicos de servicios, comandos, rutas, clases y variables en su forma técnica cuando corresponda.
- Construir una experiencia interna ligera, directa y centrada en el trabajo operativo.
- Mantener la documentación sincronizada con cambios reales — en cada cambio construido: (1) el doc del tema en `docs/`, (2) **este AGENTS.md** cuando el cambio introduzca o modifique reglas, estándares, flujos de publicación o puntos de extensión, y (3) **`docs/22_bitacora.md`** cuando haya una decisión no obvia (con alternativas descartadas), un incidente o un cambio de rumbo: entrada append-only de 3–5 líneas con fecha y tipo, la más reciente arriba, nunca editando entradas pasadas. AGENTS.md es el contrato de entendimiento para cualquier agente: se mantiene magro (reglas + índice), el detalle vive en `docs/` y el porqué histórico en la bitácora.
- Separar autenticación de autorización.
- Validar permisos en backend y reflejarlos en los elementos visibles del frontend.
- Obtener credenciales mediante SSO y servir el frontend desde S3 privado con CloudFront.
- Usar DynamoDB para autorizacion funcional y datos operativos.
- Usar Glue Catalog para metadata técnica y DynamoDB para contexto funcional.
- Usar Athena para consultas controladas, preview y monitoreo; realizar CRUD mediante los servicios operativos.
- Para AWS, trabajar con el perfil SSO `gestion-proyectos-dev` salvo instrucción contraria.
- Antes de ejecutar acciones AWS relevantes, validar que la sesión siga vigente con STS; si SSO falla por expiración, solicitar al usuario ejecutar `aws sso login --sso-session bdr-fed`.
- Usar el perfil SSO como flujo normal y mantener `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` fuera de conversaciones, comandos y archivos del proyecto.
- El workspace usa `pnpm`. El flujo vigente de publicación está en `docs/17_desarrollo_local_publicacion.md`: frontend con `scripts/deploy-frontend.sh` (nunca `s3 sync --delete` sin excluir `config.json`), y **todo deploy (backend o frontend) debe avisar a los usuarios conectados** con `scripts/deploy-flag.sh start|done` (`deploy-frontend.sh` lo hace solo).
- **Acceso a DynamoDB (estándar obligatorio, ver `docs/21_guia_nuevo_modulo.md`)**: nunca `self._table.query/scan` directos — siempre `_query_all`/`_scan_all` de `BaseRepository`; listados globales por tipo vía el GSI `byEntityType` (`_query_entity_type`); todo item nuevo lleva `entityType`; expirables con atributo `ttl`. Verificado por `scripts/check-dynamo-pagination.sh` dentro de `npm run check`.
- **Módulos y pestañas nuevos** se declaran SOLO en `backend/app/modules/manifest.py` (la matriz de Administración, etiquetas y defaults se derivan solos; no tocar `admin.ts`). La clave `home` se muestra como "Panel" y `projects`+`tasks` como "Solicitudes" (cada registro es una solicitud con `requestType`: project|report) — nunca renombrar claves persistidas, solo etiquetas.
- Correr **`npm run check`** antes de publicar cualquier cambio (build frontend + Python + estándar DynamoDB + synth CDK).
- **UI de módulos nuevos o rediseños**: seguir los 11 estándares visuales/usabilidad de `docs/06_frontend_ux.md` (objeto principal primero, maestro-detalle con tabla, una sola acción primaria, disciplina de color, acciones visibles con texto — drag&drop solo como atajo, empty states guiados, guardado con feedback inmediato — botón "Guardando…"/"✓ Guardado", merge local sin recarga completa y sin N+1 en backend, etc.). En maestro-detalle apilado (detalle debajo de la tabla), seleccionar una fila DEBE dar tres señales SIN robar el viewport: chevron ›/▾ por fila, "peek" (scroll mínimo para que el panel asome sin perder el listado; salto completo solo al hacer clic en el chevron) y destello breve del borde del panel (referencia: `revealProjectDetail(full)` en `workspace.ts`).
- **Animaciones**: sin librerías — CSS para micro-transiciones y Web Animations API para entradas de vista (`animateViewEnter` en `app.ts`), solo en navegación explícita (nunca en repintados de sondeos) y respetando `prefers-reduced-motion` (detalle en `docs/06_frontend_ux.md`).

## Stack técnico (resumen para agentes)

- **Frontend**: Astro 6 estático con una sola página y UI imperativa en TypeScript. `frontend/src/pages/index.astro` contiene el cascarón HTML; `frontend/src/scripts/app.ts` funciona como shell de sesión, navegación, estado y dependencias compartidas; `frontend/src/scripts/modules/` contiene los dominios `home`, `workspace`, `catalog`, `admin` y el submódulo `datalake`; los estilos globales viven en `frontend/src/styles/app.css`. La navegación muta `state.activeModule`, vuelve a renderizar con `innerHTML` y enlaza listeners en cada render. Verificar cambios con `pnpm build` dentro de `frontend/` (incluye `astro check`).
- **Dependencias frontend**: `@aws-sdk/client-cognito-identity-provider` implementa el login directo contra Cognito (`USER_PASSWORD_AUTH` + `NEW_PASSWORD_REQUIRED`). D3 v7 se carga bajo demanda desde `unpkg.com/d3@7` al abrir el grafo del catálogo.
- **Sesión**: tokens Cognito en `sessionStorage` (`gestionProyectosAuth`); módulo activo persistido en `gestionProyectosModule`. Configuración runtime en `/config.json` (se obtiene con `fetch` al arrancar; no forma parte del bundle).
- **Backend**: Lambda Python en `backend/app/`, con handler delgado, router por registro, módulos de rutas, servicios y repositorios por dominio; API Gateway expone sus rutas. Validar sintaxis con `npm run check:python` desde la raíz.
- **Infra**: CDK TypeScript en `infra/` (stack único `infra/lib/gestion-proyectos-stack.ts`); deploy con `npm run infra:deploy` (perfil SSO `gestion-proyectos-dev`).
- **Datos**: DynamoDB single-table (autorización funcional, datos operativos y caché del catálogo) + Glue Catalog (metadata técnica, sincronizada a DynamoDB).
- **Grafo del catálogo**: mantener render en Canvas 2D con culling por viewport, LOD de etiquetas y picking por quadtree para escalar a miles de nodos (detalle en `docs/07_catalogo_datalake.md`). Esta decisión sustituye el render SVG por nodo por razones de rendimiento.
- **Verificación completa**: `npm run check` en la raíz (build frontend + sintaxis Python + estándar de acceso a DynamoDB + synth de CDK).

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
- Desarrollo local y publicación (incluye aviso de despliegue): `docs/17_desarrollo_local_publicacion.md`
- Guía para construir un módulo nuevo (estándares obligatorios): `docs/21_guia_nuevo_modulo.md`
