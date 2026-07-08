# Estado de implementación

## Últimos avances (2026-07-07/08: adjuntos, Pizarra, filtros, Personal, vendor)

- **Pizarra: colaboración EN VIVO** (2026-07-08): varios usuarios editan el mismo tablero a la vez (cursores con nombre, presencia "N en vivo", autoguardado). API Gateway **WebSocket** serverless `wss://6nb9mm3y1d.execute-api.us-east-1.amazonaws.com/dev` (misma Lambda, ramifica por routeKey; conexiones en Dynamo con TTL; token por query param validado con GetUser). Desplegado en dev; rechazos 400/401 verificados en vivo. Ver `docs/02`.
- **Personal** (2026-07-08): ausencias del equipo (vacaciones/permiso/incapacidad) + saldo simple por año; vista desde el **menú del usuario** (no módulo); ver = usuario configurado, editar = solo admin. Desplegado en dev. Ver `docs/02`.
- **Vendor auto-hospedado** (2026-07-07): D3, Chart.js, React y Excalidraw se sirven desde `/vendor/` del bucket del frontend — sin CDNs externos. Ver bitácora.

## Avances de 2026-07-07 (adjuntos, Pizarra, filtros)

- **Adjuntos de solicitudes**: archivos (pantallazos, pdf, csv…) y queries de texto por solicitud. Bucket S3 compartido `gad-storage-dev-186281981036` (privado, RETAIN, prefijo `gestion-proyectos/`, IAM acotado) + presigned PUT/GET; items `ATTACHMENT` en Dynamo; franja "Adjuntos" con selector "Relacionar con" (General / seguimiento / + Nueva nota). Desplegado en dev. Ver `docs/08`.
- **Módulo Pizarra** (`draw`): lienzo Excalidraw (unpkg bajo demanda), compartir selectivo con aceptación, escenas en S3 bajo `drawings/`. Desplegado en dev; se asigna por usuario en Administración. Ver `docs/02`.
- **Filtros de Solicitudes**: popover `Filtros ▾` con badge + chips removibles; nuevo filtro y columna "Grupo de trabajo" (antes "Área destino"; `targetAreaId`, columna oculta por defecto). Ver `docs/06`.
- **Guardrail**: `check:python` ahora compila recursivo todo `backend/app` + `backend/scripts` (excluye `_vendor`) — antes omitía `modules/` y `core/`.

## Avances previos (monitoreo de cargas + mejoras de Inicio)

- **Monitoreo de cargas del data lake** (pestaña Data Lake): histograma diario de **archivos y peso** por zona y área (Fase 1: listado S3 con colector intercambiable hacia S3 Inventory en Fase 2), escaneo asíncrono (`datalake_ingest_scan`), caché en DynamoDB (`DATALAKE#INGEST`) con TTL 12 h + botón "Escanear ahora". Sub-módulo frontend `modules/datalake.ts` compuesto por Inicio. Alcance inicial: `arc-enterprise-data` (landing/staging). Ver `docs/02_modulos_funcionales.md`.
- **Inicio en pestañas** Resumen / Data Lake / Facturación, con visibilidad de pestañas por usuario (permisos `home_resumen`, `home_datalake`; Facturación es admin-only). Títulos de sección colapsables.
- **Facturación mejorada**: cuentas **config-driven** (fuente única `costAccounts` en el stack → env `COST_ACCOUNTS`, selector + whitelist + IAM AssumeRole derivados), nombres reales de cuenta en el selector; **detalle por servicio** (desglose por `USAGE_TYPE` con unidad), **Detalle diario** (tabla Diario/Gasto/Variación con detección del día de mayor aumento y su servicio causante), **tendencia que respeta Neto/Bruto**, y "Actualizar ahora" que invalida toda la caché del periodo.
- **Sesión**: renovación silenciosa del idToken con el refreshToken mientras el usuario está activo; aviso de expiración y regreso al login (sin pantalla congelada).

## Avances previos (refactor a arquitectura modular + módulos nuevos)

- **Módulo Inicio (dashboard)** implementado: pestañas Resumen (proyectos/tareas/personas + catálogo, con gráficas Chart.js) y Facturación (costos AWS, solo admin). Costos vía Cost Explorer con selector de cuenta **186281981036 (app)** y **396913696127 (hub, vía rol cross-account `gestion-proyectos-cost-reader` + AssumeRole)**, toggle bruto/neto, caché en DynamoDB (`HOME#COSTS`) con TTL diferenciado y botón "Actualizar ahora". Ver `docs/02_modulos_funcionales.md`.
- **Módulo Administración funcional**: alta/edición/eliminación de usuarios (perfil + módulos + rol + estado) desde la UI; solo Cognito sigue manual. Guard de rol admin en backend. Ver `docs/09_admin_accesos.md`.
- **Borrado** de proyectos, tareas, personas (dentro del panel de edición) y de usuarios (admin), con cascada y confirmación.
- **Refactor SOLID (sin cambiar el contrato HTTP):**
  - Backend: `handler.py` delgado + `core/router.py` (router por registro, autodescubrimiento de `modules/*_routes.py`), guards y errores centralizados, **un repositorio por dominio** (se eliminó la god-class `MainTableRepository`).
  - Frontend: `app.ts` convertido en shell y lógica de dominio extraída a `scripts/modules/` (`home`, `workspace`, `catalog`, `admin`, `datalake`) por inyección de dependencias.
  - Objetivo: agregar módulos desde una fuente independiente sin tocar el núcleo.

## Corte actual

Primer entregable implementado y desplegado en `dev`:

- Monorepo con `frontend/`, `backend/`, `infra/` y `docs/`.
- Frontend Astro estático con login Cognito propio en español, opción de cancelar, cambio de contraseña inicial, carga de `/api/me` y menú dinámico por módulos.
- Backend Lambda Python con rutas `GET /health` y `GET /api/me`.
- API inicial de proyectos/tareas con workspace, creación rápida y actualización de tareas.
- UX de `Proyectos y tareas` publicada como una sola mesa de trabajo: personas, proyectos y tareas conviven en la misma pantalla; el menú ya no separa `Tareas` como ventana independiente.
- Panel de detalle contextual publicado para editar persona, proyecto, rol de miembro y tarea desde la misma pantalla.
- Ajuste UX publicado para `Proyectos y tareas`: creación de personas y tareas colapsada hasta presionar `Crear`, tarjetas de tareas más compactas y edición abierta solo por botón explícito `Editar tarea` o `Editar proyecto`.
- Mejora integral de interacción publicada para `Proyectos y tareas`: el detalle contextual se alinea con el proyecto editado, las acciones usan `Crear`, `Editar`, `Guardar` y `Cancelar` de forma consistente, y las altas rápidas muestran confirmación breve cerca del área afectada.
- Ajuste de lenguaje y edición de personas publicado: en la mesa operativa se usa `persona` para integrantes de proyectos y tareas, `usuario` queda reservado para acceso/autenticación, y la franja `Personas registradas` permite abrir `Editar persona` para actualizar área, estado, notas o vacaciones/disponibilidad.
- Ajuste compacto de edición publicado: las acciones `Editar persona`, `Editar tarea` y `Editar proyecto` se muestran como ícono de lápiz con etiqueta accesible, la franja `Personas registradas` queda reducida a nombre e ícono, y el estado de persona es opcional sin badge cuando no está definido.
- Mejora frontend publicada para la pantalla inicial sin sesión: el acceso se separa en una portada moderna de login que oculta menú, módulos, encabezado operativo y paneles internos hasta que el usuario inicie sesión.
- Mejora de búsqueda publicada para `Proyectos y tareas`: la búsqueda principal usa un solo input con alcance `Proyectos`/`Tareas`, la búsqueda de personas queda separada, y filtrar proyectos ya no oculta personas registradas ni afecta el selector `Agregar persona`.
- Documentación de arquitectura y operación actualizada: el README enlaza la guía visual de arquitectura serverless por capas y `docs/17_desarrollo_local_publicacion.md` documenta componentes, puertos, flujo local, publicación backend/frontend, verificación e infraestructura.
- Corrección frontend publicada para creación/edición de formularios: se conserva la referencia del formulario antes de llamadas asíncronas para evitar errores `currentTarget` nulo al crear usuarios, proyectos o tareas.
- Mejora UX/API publicada para `Proyectos y tareas`: quitar miembros de un proyecto arrastrándolos de vuelta a `Personas`, quitar responsable de tareas por drag and drop, franja superior con altura controlada y menú lateral colapsable.
- Repositorio DynamoDB para perfil funcional y módulos de usuario.
- Infraestructura AWS CDK TypeScript para `dev`.
- Seed automático en CDK para usuario inicial y módulos base.
- Módulo `Catálogo Data Lake` implementado y desplegado: backend con `GlueRepository` y `CatalogService` (listado de bases/tablas, detalle de tabla, sync por tabla, por base y global), cache de metadata en DynamoDB, sync global asíncrono por auto-invocación de la Lambda (`action: catalog_sync_all`), y contexto funcional editable por tabla y columna.
- Frontend de catálogo publicado: búsqueda con filtros de alcance (bases/tablas/columnas), detalle de tabla con columnas y contexto funcional, y grafo de relaciones D3.js con carga de columnas bajo demanda y exclusión de columnas de partición en las relaciones.
- Migración del workspace a `pnpm` (`pnpm-workspace.yaml`); el build de frontend se ejecuta con `pnpm build` dentro de `frontend/`.
- Branding actualizado en la portada de login con logo propio (`icono_gp.png`).
### Corte histórico previo a la publicación modular (junio de 2026)

Este bloque conserva el estado local anterior a los despliegues documentados después.
Sirve como trazabilidad y no define pendientes vigentes:

- Frontend: persistencia del módulo activo al recargar (`sessionStorage`); reescritura del grafo del catálogo a Canvas 2D (esferas de Fibonacci 3D proyectado, culling, LOD, quadtree, pan con dos dedos y zoom con pellizco, uniones visibles solo con foco, precarga de columnas al abrir, rotación trackball de 2 ejes con clic sostenido, doble clic para reorientar, "traer al frente" desde inspector/buscador); corrección de la búsqueda por `Columna`/`Desc. columna` para evaluar todas las tablas con precarga en segundo plano.
- Backend: sync de catálogo diferencial por `glueUpdatedAt` (`UpdateTime` de Glue, verificado en dev) con eliminación de tablas huérfanas; endpoints de sync devuelven `updated` y `removed`. Requiere publicar la Lambda. Primer sync tras publicar reescribe todo una vez (el caché previo no tiene `glueUpdatedAt`); desde el segundo es diferencial.
- Infra: se agregaron al stack CDK las 8 rutas de `/api/catalog/*` con `jwtAuthorizer` (antes existían solo en API Gateway por configuración manual = config drift; verificado que en vivo responden 401 sin token, pero no estaban versionadas). Requiere `npm run infra:deploy`. Sin esto, un `cdk deploy` podía borrarlas y el paso a producción no las habría creado.
- Infra: el rol de ejecución de la Lambda ahora se define explícito en CDK con nombre estable (`gestion-proyectos-dev-api-role`) y todos sus permisos en código (DynamoDB RW, logs, Glue read-only, auto-invocación) — elimina el drift de permisos puestos a mano y da ARN estable para grants externos (bucket policies cross-account, Lake Formation). En prod se sigue importando vía `apiRoleArn`. **Ojo al desplegar:** el `cdk deploy` reemplaza el rol autogenerado anterior por el nombrado; el permiso de Glue manual del rol viejo se pierde pero queda cubierto por el código. Cualquier grant externo apuntando al rol viejo debe repuntarse al nuevo ARN (última vez que cambia).
- Frontend: separación de responsabilidades — `index.astro` (cascarón), `src/scripts/app.ts` (SPA), `src/styles/app.css` (estilos).
- Detalle en `docs/07_catalogo_datalake.md` y `docs/18_servicios_y_runtime.md`.

## Recursos desplegados

| Recurso | Valor |
| --- | --- |
| Stack | `GestionProyectosDevStack` |
| Frontend URL | `https://d269paz1z7q1g0.cloudfront.net/` |
| API URL | `https://63ibnl13da.execute-api.us-east-1.amazonaws.com/` |
| WebSocket URL (Pizarra en vivo) | `wss://6nb9mm3y1d.execute-api.us-east-1.amazonaws.com/dev` (API `gestion-proyectos-dev-draw-ws`) |
| S3 frontend bucket | `gestion-proyectos-dev-frontend-186281981036` |
| S3 storage bucket (adjuntos + pizarras) | `gad-storage-dev-186281981036` — privado total, RETAIN, compartible entre apps por prefijo (`gestion-proyectos/`); IAM de la Lambda acotado al prefijo; CORS PUT/GET/HEAD solo desde el origen CloudFront |
| CloudFront distribution | `E2K3CA110228B1` |
| Cognito User Pool | `us-east-1_lN4JYAVlQ` |
| Cognito App Client | `uhquk1hakj8nifgi3j6hv8dbh` |
| Cognito domain prefix | `gestion-proyectos-dev-186281981036` |
| DynamoDB table | `gestion-proyectos-dev-main` |
| Lambda API | `gestion-proyectos-dev-api` |
| Rol de ejecución Lambda | `gestion-proyectos-dev-api-role` (ARN `arn:aws:iam::186281981036:role/gestion-proyectos-dev-api-role`), nombre estable definido en CDK y verificado en AWS el 2026-06-26; usar este ARN para grants externos (S3 cross-account, Lake Formation) |
| Permisos del rol | DynamoDB RW sobre `gestion-proyectos-dev-main` · logs · Glue read-only (`GetDatabases/GetDatabase/GetTables/GetTable/GetPartitions`) · `lambda:InvokeFunction` sobre sí mismo (sync) · S3 RW sobre `gad-storage-dev-…/gestion-proyectos/*` (adjuntos y pizarras, acotado al prefijo) · `execute-api:ManageConnections` sobre la API WebSocket (empujar mensajes a la sala) |
| Usuario inicial | `usr041100@banrural.com.gt` |

## Recursos definidos por CDK

- S3 privado para frontend: `gestion-proyectos-dev-frontend-186281981036`.
- CloudFront con acceso privado al bucket.
- Cognito User Pool, dominio Hosted UI disponible como respaldo y App Client público.
- API Gateway HTTP API.
- JWT Authorizer conectado al User Pool.
- Lambda Python `gestion-proyectos-dev-api`.
- DynamoDB `gestion-proyectos-dev-main` con `PK` y `SK`.
- CloudWatch Logs con retención de 30 días.
- Outputs para publicar frontend manualmente: bucket S3, distribución CloudFront, API URL y valores Cognito.

## Perfil AWS

Usar siempre:

```bash
aws sts get-caller-identity --profile gestion-proyectos-dev --region us-east-1 --no-cli-pager
```

Las credenciales del perfil son temporales y se renuevan con AWS SSO. Antes de acciones AWS relevantes, validar sesión con STS. Si SSO expiró, solicitar al usuario ejecutar `aws sso login --sso-session bdr-fed`.

## Comandos validados

```bash
npm install
npm run build -w frontend
PYTHONPYCACHEPREFIX=/private/tmp/gestion-proyectos-pycache python3 -m py_compile backend/app/*.py backend/app/repositories/*.py backend/app/services/*.py backend/scripts/*.py
npm run build -w infra
npm run synth -w infra
npm run check
```

Resultado: pasan localmente.

El despliegue CDK terminó en `CREATE_COMPLETE`.

En el ajuste de login del 2026-06-05, `npm run infra:deploy` no pudo aplicar el cambio porque el CDK CLI no resolvió las credenciales SSO del perfil, aunque `aws sts` y AWS CLI sí funcionaban con `gestion-proyectos-dev`. Para no bloquear el cambio, se actualizó el App Client con AWS CLI y el CDK quedó sincronizado con el mismo estado deseado.

```bash
aws cognito-idp update-user-pool-client \
  --user-pool-id us-east-1_lN4JYAVlQ \
  --client-id uhquk1hakj8nifgi3j6hv8dbh \
  --client-name gestion-proyectos-dev-web \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --callback-urls http://localhost:4321/ https://d269paz1z7q1g0.cloudfront.net/ \
  --logout-urls http://localhost:4321/ https://d269paz1z7q1g0.cloudfront.net/ \
  --supported-identity-providers COGNITO \
  --allowed-o-auth-flows-user-pool-client \
  --prevent-user-existence-errors ENABLED \
  --access-token-validity 60 \
  --id-token-validity 60 \
  --refresh-token-validity 1440 \
  --token-validity-units AccessToken=minutes,IdToken=minutes,RefreshToken=minutes \
  --profile gestion-proyectos-dev \
  --region us-east-1
```

En el corte de proyectos/tareas del 2026-06-05 se usó el mismo criterio operativo: CDK queda sincronizado, pero la actualización publicada se aplicó con AWS CLI. Acciones realizadas:

- `aws lambda update-function-code` para `gestion-proyectos-dev-api`.
- `aws apigatewayv2 create-route` para `GET /api/workspace`, `POST /api/people`, `POST /api/projects`, `POST /api/projects/{projectId}/members`, `POST /api/projects/{projectId}/tasks` y `PATCH /api/projects/{projectId}/tasks/{taskId}`.
- `aws lambda add-permission` para permitir invocación desde las rutas `/api/*`.

En el corte de panel de detalle del 2026-06-05 se aplicaron con AWS CLI:

- `aws lambda update-function-code` para `gestion-proyectos-dev-api`.
- `aws apigatewayv2 create-route` para `PATCH /api/people/{personId}`, `PATCH /api/projects/{projectId}` y `PATCH /api/projects/{projectId}/members/{personId}`.
- `aws apigatewayv2 update-api` para permitir `PATCH` en CORS desde CloudFront.
- `aws lambda add-permission` para permitir invocación desde las nuevas rutas `PATCH`.

En el corte de drag and drop reversible del 2026-06-05 se aplicaron con AWS CLI:

- `aws lambda update-function-code` para `gestion-proyectos-dev-api`.
- `aws apigatewayv2 create-route` para `DELETE /api/projects/{projectId}/members/{personId}`.
- `aws lambda add-permission` para permitir invocación desde la nueva ruta `DELETE`.

## Publicación frontend

El frontend se publica fuera de CDK para evitar depender de `BucketDeployment`:

```bash
npm run build -w frontend
aws s3 sync frontend/dist/ s3://gestion-proyectos-dev-frontend-186281981036/ --delete --profile gestion-proyectos-dev --region us-east-1
aws s3 sync /private/tmp/gestion-proyectos-public-config/ s3://gestion-proyectos-dev-frontend-186281981036/ --cache-control no-store --profile gestion-proyectos-dev --region us-east-1
aws cloudfront create-invalidation --distribution-id E2K3CA110228B1 --paths "/*" --profile gestion-proyectos-dev
```

El archivo runtime `/config.json` debe contener solamente valores públicos del ambiente:

```json
{
  "environment": "dev",
  "region": "us-east-1",
  "apiBaseUrl": "https://63ibnl13da.execute-api.us-east-1.amazonaws.com/",
  "cognitoUserPoolId": "us-east-1_lN4JYAVlQ",
  "cognitoClientId": "uhquk1hakj8nifgi3j6hv8dbh",
  "cognitoDomain": "gestion-proyectos-dev-186281981036"
}
```

## Advertencias actuales

- `npm install` reporta vulnerabilidades transitivas: 8 moderadas y 2 altas. No se ejecutó `npm audit fix --force` para no romper versiones CDK/Astro.
- CDK emite advertencias por usar paquetes alpha de API Gateway v2 en versión `2.114.1-alpha.0`; se aceptan por ahora para mantener HTTP API con JWT Authorizer.
- CDK advierte que Node `v25.9.0` no está dentro del rango probado por esa versión. El synth pasa; para despliegues repetibles conviene usar una versión LTS de Node.
- `BucketDeployment` de CDK falló previamente al copiar assets desde el bucket bootstrap cifrado con SSE-KMS. La pila final evita ese custom resource y publica el frontend con `aws s3 sync`.

## Pruebas realizadas

- `curl -I https://d269paz1z7q1g0.cloudfront.net/` devuelve `HTTP/2 200`.
- `curl https://d269paz1z7q1g0.cloudfront.net/config.json` devuelve los valores runtime reales.
- `curl -i https://63ibnl13da.execute-api.us-east-1.amazonaws.com/health` devuelve `HTTP/2 200` con `{ "status": "ok" }`.
- `curl -i https://63ibnl13da.execute-api.us-east-1.amazonaws.com/api/me` sin token devuelve `HTTP/2 401`, esperado por el JWT Authorizer.
- `npm run check` pasa con build frontend, compilación Python y synth CDK.
- Invalidation CloudFront `I1WXOKWHFS865T5G4OODVK2YGM` terminó en `Completed` para el login propio con opción de cancelar.
- Invalidation CloudFront `IAR5ROM62ZVE5HWZITTEDTFQEK` terminó en `Completed` para la mesa de trabajo de proyectos/tareas.
- Cognito App Client confirma `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_USER_SRP_AUTH` y `ALLOW_REFRESH_TOKEN_AUTH`.
- Invocación directa de Lambda para `GET /api/workspace` con el usuario inicial devuelve `ok: true` y colecciones vacías listas para trabajar.
- Invalidation CloudFront `I9MLVS90MSBW526FYCB8FQUYKJ` terminó en `Completed` para la UX unificada de proyectos/tareas.
- Invocación directa de Lambda para `GET /api/me` con el usuario inicial devuelve `ok: true` y módulos ordenados por prioridad funcional.
- Invalidation CloudFront `I2F1PDL8YPUDNE23CFEFSUA0HX` terminó en `Completed` para el panel de detalle.
- Invalidation CloudFront `I1WEPCARA5O1OWVGU8ILWD6NRB` terminó en `Completed` para el ajuste UX de formularios colapsados y detalle explícito de tareas.
- Invalidation CloudFront `I9MROWSUVDA5CBY8AGQFXH569W` terminó en `Completed` para la corrección de formularios con `currentTarget` nulo.
- Invalidation CloudFront `I7OF6QESUK4DQUCZZBAQZKX065` terminó en `Completed` para drag and drop reversible y menú lateral colapsable.
- Invalidation CloudFront `IAR80SN8MVX9ZERTOVKKGLZU8H` terminó en `Completed` para el ajuste visual de tablero: salida por drag and drop sobre `Personas`, lista de proyectos con scroll interno y tarjetas de tareas sin solapamiento.
- Invalidation CloudFront `I7FS6K4HF8IVY48GPHYWOKJ5P7` terminó en `Completed` para filtros de proyectos por estado, estado visible en tarjetas de proyecto y salida por drag and drop sobre cualquier punto del panel `Personas` sin cuadro adicional.
- Invalidation CloudFront `I476ZMUKJAUNHCSIE92CRWYLV6` terminó en `Completed` para la vista principal de proyectos con tareas visibles: búsqueda general, creación de proyecto como acción principal, personas dentro de cada proyecto, resumen de tareas por estado y tablero expandible por proyecto.
- Invalidation CloudFront `I4RIINL2B8C30DQFVC4HGHQB32` terminó en `Completed` para corregir la doble vista al abrir `Ver tablero`, agregar colores contextuales por estado/prioridad y mostrar confirmación al guardar proyecto.
- Invalidation CloudFront `IBP1FOY2E529SW1WID60QN8Q3D` terminó en `Completed` para agregar confirmación visible al guardar tarea desde el panel de detalle.
- Invalidation CloudFront `IL8OPCXNKPI533FN2AN990BGG` terminó en `Completed` para restaurar `/config.json` runtime real con `CacheControl: no-store` después de detectar el config local vacío durante la verificación.
- Invalidation CloudFront `I3R001EHICY4KGXB6ESMOYHSPH` terminó en `Completed` para mover el detalle contextual a un panel lateral derecho en escritorio, bottom sheet en móvil y simplificar la asignación de responsable de tareas.
- Invalidation CloudFront `IE0E6ITW01V3U967ZA18X6RDZH` terminó en `Completed` para permitir `Ninguno` en estado de proyecto y responsable, y `Ninguna` en prioridad de tarea.
- Invalidation CloudFront `I5BPNEOO8IIBHR805GZZD4GAVE` terminó en `Completed` para alinear el panel de edición con el proyecto seleccionado, normalizar microcopy de acciones, ocultar ruido de campos opcionales vacíos y agregar confirmación a creación rápida de usuario, proyecto y tarea.
- Invalidation CloudFront `I9UQAULOAE2RNQZDJ6SSFP2J44` terminó en `Completed` para publicar la franja `Personas registradas`, el cambio de lenguaje de usuario operativo a persona y la edición visible de vacaciones/disponibilidad.
- Invalidation CloudFront `I89HZQZV5DYQEU4XV6WTNYV397` terminó en `Completed` para publicar edición por ícono, personas compactas y estado opcional de persona.
- Invocaciones directas de Lambda validan edición de persona, proyecto, rol de miembro y tarea.
- Lambda `gestion-proyectos-dev-api` fue publicada con `CodeSha256` `wscr50KCvGhpxbayfAeXx877sFK4tfgBoycnMdqd0gg=` para aceptar estado de proyecto y prioridad de tarea opcionales sin imponer valores por defecto.
- DynamoDB registra `AUDIT_EVENT` para cambios de tarea en `status`, `priority` y `assigneePersonId`.
- Validación negativa: prioridad inválida devuelve `400 VALIDATION_ERROR`.
- Validación negativa: usuario sin módulos funcionales devuelve `403 FORBIDDEN`.
- Preflight CORS `OPTIONS` para `PATCH` desde CloudFront devuelve `204` con `access-control-allow-methods` incluyendo `PATCH`.
- Verificación publicada: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva los valores runtime reales y el bundle servido contiene `togglePersonFormButton`, `toggleTaskFormButton`, `data-detail-task` y layout `280px minmax(0,1fr)`.
- Verificación publicada del fix de formularios: el bundle servido por CloudFront usa una referencia local del formulario antes de `await` y ejecuta `reset()` sobre esa referencia.
- Verificación publicada de drag and drop reversible: Lambda responde `ok: true` para `DELETE /api/projects/{projectId}/members/{personId}`, API Gateway rechaza `DELETE` sin token con `401`, CORS permite `DELETE` desde CloudFront, y el bundle servido contiene `projectMember`, `taskAssignee`, `sidebarCollapsed` y `workspaceTopRow`.
- Verificación publicada del ajuste visual: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva los valores runtime reales, el bundle servido contiene `data-people-drop-zone` y la función de salida sobre `Personas`, el CSS servido contiene `repeat(4,minmax(0,1fr))`, `overflow-wrap:anywhere` y `projectList` con `max-height:240px`; el bundle ya no contiene `taskUnassignZone`, `data-project-member-remove` ni el texto de la zona separada para sacar miembros.
- Verificación publicada de filtros de proyecto: CloudFront devuelve `HTTP/1.1 200`, el HTML apunta a los assets `_astro/index.DkD0jP3z.css` y `_astro/index.astro_astro_type_script_index_0_lang.D7F4H8LC.js`, el bundle servido contiene `projectStatusFilter`, `data-project-status-filter`, `statusBadge` y `data-people-drop-zone`; el CSS servido contiene `projectFilters`, `filterChip` y `statusBadge`; el bundle no contiene `dropHint`, `data-project-member-remove` ni el texto del cuadro anterior.
- Verificación publicada de vista general por proyecto: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva los valores runtime reales, el HTML apunta a `_astro/index.BwOxn8QZ.css` y `_astro/index.astro_astro_type_script_index_0_lang.E89237E9.js`, el bundle servido contiene `Proyectos con tareas visibles`, `workspaceSearch`, `projectOverviewCard` y `data-toggle-board`; el CSS servido contiene `workspaceHero`, `projectOverviewCard`, `projectTaskGroups` y `taskSummaryRow`.
- Verificación publicada de corrección visual y feedback: CloudFront devuelve `HTTP/1.1 200`, el HTML apunta a `_astro/index.BeBDBElM.css` y `_astro/index.astro_astro_type_script_index_0_lang.CxV8nlLr.js`, el bundle servido contiene `Proyecto guardado correctamente`, `saveFeedback`, `priorityBadge` y render condicionado de `projectTaskGroups`/`kanbanBoard`; el CSS servido contiene `projectStatus-closed`, `taskStatus-review`, `taskStatus-done`, `priorityBadge` y `saveFeedback`.
- Verificación publicada de feedback en tareas: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva los valores runtime reales de `dev`, el objeto S3 `config.json` tiene `CacheControl: no-store`, el HTML apunta a `_astro/index.BeBDBElM.css` y `_astro/index.astro_astro_type_script_index_0_lang.DmUkdTqk.js`, y el bundle servido contiene `Tarea guardada correctamente`, `Proyecto guardado correctamente` y `saveFeedback`.
- Verificación publicada de detalle contextual compacto: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva valores runtime reales de `dev`, el objeto S3 `config.json` tiene `CacheControl: no-store`, el HTML apunta a `_astro/index.DM2qNvAZ.css` y `_astro/index.astro_astro_type_script_index_0_lang.CvHw8x_3.js`, el bundle servido contiene `detailDrawerSlot`, `data-focus-task-assignee`, `Arrastra para cambiar estado.` y `Tarea guardada correctamente`; el bundle ya no contiene `Arrastra para cambiar estado o asignar persona`; el CSS servido contiene `projectOverview.hasDetail`, `detailDrawerSlot` y `tinyButton.subtle`.
- Verificación publicada de campos opcionales: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva valores runtime reales de `dev`, el objeto S3 `config.json` tiene `CacheControl: no-store`, el HTML apunta a `_astro/index.DM2qNvAZ.css` y `_astro/index.astro_astro_type_script_index_0_lang.Eg7lXEju.js`, el bundle servido contiene `Ninguno`, `Ninguna`, `Sin estado`, `projectStatusFilter` y `priority-none`; la Lambda responde `ok: true` en `/health` después del despliegue.
- Verificación publicada de mejora integral de interacción: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva valores runtime reales de `dev`, el objeto S3 `config.json` tiene `CacheControl: no-store`, el HTML apunta a `_astro/index.C4tWkBZQ.css` y `_astro/index.astro_astro_type_script_index_0_lang.ByRf2pYs.js`, el bundle servido contiene `Editar tarea`, `Cancelar`, `Crear usuario`, `personas registradas`, `Usuario creado.`, `Proyecto creado.`, `Tarea creada.` y `hasInlineDetail`; el bundle ya no contiene `Cerrar tarea`, `Cerrar usuario`, `Owner` ni el botón de tarea `Detalle`.
- Verificación local de lenguaje y edición de personas: `npm run check` pasa; el build genera `_astro/index.Bu7XeUhT.css`, `_astro/index.astro_astro_type_script_index_0_lang.CtcVh7Q2.js` y `_astro/index.browser.Crqmr0ki.js`; el frontend contiene `Registrar persona`, `Editar persona`, `Guardar persona`, `Persona registrada.`, `Persona guardada correctamente.` y `Personas registradas`; ya no contiene `Crear usuario`, `Guardar usuario`, `Usuario creado`, `Usuarios disponibles`, `Usuario no encontrado`, `project owner` ni `Usuarios del proyecto` dentro de la mesa operativa.
- Verificación publicada de lenguaje y edición de personas: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva valores runtime reales de `dev`, el objeto S3 `config.json` tiene `CacheControl: no-store`, el HTML apunta a `_astro/index.Bu7XeUhT.css` y `_astro/index.astro_astro_type_script_index_0_lang.CtcVh7Q2.js`, el bundle/CSS publicado contiene `Registrar persona`, `Editar persona`, `Guardar persona`, `Persona registrada.`, `Persona guardada correctamente.`, `Personas registradas`, `personDirectory`, `personDetailSlot` y `personStatusBadge`; la revisión visual pública muestra `Acceso requerido` con la app inicializada y el botón `Ingresar`.
- Verificación publicada de edición compacta: `npm run check` pasa; Lambda `gestion-proyectos-dev-api` fue publicada con `CodeSha256` `Vk/n7RGPN01Ugt4ztAbijPERkYXMx3U4nfVK5ubbZt8=` para aceptar estado opcional de persona; CloudFront devuelve `HTTP/1.1 200`; `/config.json` conserva valores runtime reales de `dev` y `CacheControl: no-store`; `/health` devuelve `ok: true`; el HTML apunta a `_astro/index.CFtW_v5_.css` y `_astro/index.astro_astro_type_script_index_0_lang.BZ5QpYOp.js`; el bundle/CSS publicado contiene `iconTinyButton`, `aria-label="Editar persona"`, `aria-label="Editar tarea"`, `aria-label="Editar proyecto"`, `Personas registradas` y `Ninguno`; el bundle publicado no contiene botones visibles `Editar persona</button`, `Editar tarea</button` ni `Editar proyecto</button`, y ya no contiene `personStatusBadge`.
- Invalidation CloudFront `IATQSZBCY93DDCND9EIQI8TBD5` terminó en `Completed` para publicar la nueva portada de acceso sin sesión.
- Verificación publicada de portada de acceso: CloudFront devuelve `HTTP/2 200`, `/config.json` conserva valores runtime reales de `dev` y `CacheControl: no-store`; el HTML apunta a `_astro/index.BeRdp3V9.css` y `_astro/index.astro_astro_type_script_index_0_lang.DjgGV6QI.js`; revisión visual pública confirma `shell loginOnly`, portada `Gestión de Proyectos`, botón `Ingresar` habilitado, ambiente `dev`, y cero elementos visibles de menú lateral, navegación, encabezado operativo, panel de estado o contenido interno antes de iniciar sesión.
- Invalidation CloudFront `I8N7RWDWJXIZD95RIVH42RF6TH` terminó en `Completed` para centrar la portada de acceso en pantallas anchas.
- Verificación publicada de portada en pantalla ancha: CloudFront devuelve `HTTP/2 200`, `/config.json` conserva valores runtime reales de `dev` y `CacheControl: no-store`; el HTML apunta a `_astro/index.DFwwwkYS.css`; en viewport de `2048x650`, el bloque de marca y la tarjeta de ingreso quedan centrados como unidad, con márgenes laterales equivalentes y separación interna de `38px`.
- Invalidation CloudFront `I7777H87J0FYK53QIAO4W1VUCG` terminó en `Completed` para publicar la búsqueda con alcance de proyectos/tareas y búsqueda independiente de personas.
- Verificación publicada de búsqueda: CloudFront devuelve `HTTP/2 200`, `/config.json` conserva valores runtime reales de `dev` y `CacheControl: no-store`; con sesión de prueba, buscar `rec` muestra `Proyecto Recuperación de cartera`, mantiene visibles las dos personas registradas y conserva opciones disponibles en `Agregar persona`; apagar `Proyectos` deja activo `Tareas` y no permite apagar ambos alcances; `Buscar persona` filtra solo la franja de personas y no oculta proyectos.

## Publicación frontend vigente (2026-06)

Tras la migración a `pnpm`, el flujo de publicación de frontend usado en la práctica es:

```bash
cd frontend
pnpm build
cp /tmp/config-prod.json dist/config.json
aws s3 sync dist/ s3://gestion-proyectos-dev-frontend-186281981036 --delete --profile gestion-proyectos-dev --exclude config.json
aws cloudfront create-invalidation --distribution-id E2K3CA110228B1 --paths "/*" --profile gestion-proyectos-dev
```

`/tmp/config-prod.json` contiene los valores runtime públicos de `dev` (no versionado). El `--exclude config.json` evita que el sync borre el config publicado.

## Catálogo Data Lake: visibilidad pendiente

La Lambda `gestion-proyectos-dev-api` (rol `gestion-proyectos-dev-api-role` tras `infra:deploy`; antes el autogenerado por CDK) solo ve las bases Glue locales en modo legado `IAM_ALLOWED_PRINCIPALS` (`arc_dev`, `arc_sandbox_desa`, `default`). Las bases del data lake hub (cuenta `396913696127`) requieren, pendiente de ejecutar:

1. Lado hub (perfil `bdr-fed`): grants Lake Formation `DESCRIBE` (base + `ALL_TABLES`) hacia la cuenta `186281981036` por cada base compartida.
2. Lado consumidor (CDK): resource links por base compartida y grant `DESCRIBE` sobre cada link únicamente al rol de la Lambda, sin abrir visibilidad a otros usuarios o aplicaciones.

## Siguiente paso operativo

1. Ejecutar los grants Lake Formation del lado hub y completar los resource links por CDK para que el catálogo vea todas las bases del data lake.
2. Validar con sesión real el módulo de catálogo completo: búsqueda, detalle, grafo de relaciones y edición de contexto funcional.
3. Agregar comentarios simples a tareas si el flujo de edición queda aprobado.

Usuario inicial para prueba: `usr041100@banrural.com.gt`.
