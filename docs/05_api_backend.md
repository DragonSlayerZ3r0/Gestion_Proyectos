# API backend

## Tecnologia base

- API Gateway.
- Lambda Python.
- DynamoDB para datos operativos.
- Boto3 para integraciones AWS.
- Respuestas JSON estandar.

## Estructura del backend (modular, SOLID)

```text
backend/app/
  handler.py            # delgado: arma el router (cold start) y despacha
  auth.py               # identidad desde el JWT (email = userId)
  responses.py          # success() / error() + serialización (Decimal)
  core/
    router.py           # Router por plantillas + guards + traducción de errores (DRY)
    request.py          # Request: identidad perezosa, parseo de body
    guards.py           # ensure_module_access / ensure_admin (declarativos)
    errors.py           # ValidationError, UserNotConfiguredError (kernel)
  modules/
    manifest.py         # fuente única de módulos del sistema
    identity_routes.py  # /health, /api/me
    workspace_routes.py # proyectos, personas, tareas
    catalog_routes.py   # catálogo + contexto funcional
    home_routes.py      # resumen + costos
    datalake_routes.py  # monitoreo de cargas y registros
    athena_routes.py    # consumo y antipatrones de Athena
    admin_routes.py     # gestión de usuarios
  repositories/
    base.py             # conexión a la tabla + helper _update genérico
    users.py / workspace.py / catalog.py / home.py / datalake.py / athena_monitor.py / glue.py
  services/
    users.py / workspace.py / catalog.py / home.py / datalake.py / athena_monitor.py / admin.py
```

**Pluggable**: para agregar un módulo basta crear `modules/<algo>_routes.py` con una
función `register(router)`; `build_router()` lo **autodescubre** (`pkgutil`) y mantiene
estables el handler y el núcleo. Cada dominio tiene su propio repositorio. El handler
se limita a adaptar eventos síncronos o asíncronos y delegar al router o servicio correspondiente.

**Ruteo en API Gateway (proxy)**: el HTTP API usa **una sola ruta catch-all `/api/{proxy+}`**
(GET/POST/PATCH/PUT/DELETE, con JWT authorizer) + `/health` pública. La Lambda resuelve
cada endpoint con su router interno (por `rawPath`). Un endpoint privado nuevo queda
cubierto por el proxy al registrarlo en su módulo backend. Esta estructura mantiene
estable `infra/` y controla el tamaño de 20 KB del *resource policy* de Lambda.

> **Cómo agregar un módulo nuevo (paso a paso, backend + frontend): ver `docs/21_guia_nuevo_modulo.md`.**

## Formato estandar de respuesta

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

Error:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "FORBIDDEN",
    "message": "No tiene permiso para ejecutar esta accion."
  }
}
```

## Manejo de errores

Centralizado en `core/router.py`: las rutas lanzan excepciones de dominio y el
router las traduce a HTTP en un solo lugar (se eliminó el `try/except` repetido en
cada handler). Mapeo: `ValidationError`→400, fallo de JWT→401, `PermissionError`→403,
`UserNotConfiguredError`→403 `USER_NOT_CONFIGURED`, `ValueError` de negocio→404, resto→500.

- `400`: solicitud invalida.
- `401`: no autenticado.
- `403`: sin permiso funcional.
- `404`: recurso no encontrado.
- `409`: conflicto de estado o duplicado.
- `500`: error inesperado.

## Endpoints iniciales

```text
GET /api/me
GET /api/workspace
GET /api/home/summary
GET /api/home/costs
GET /api/home/cost-accounts
GET /api/home/costs/detail
GET /api/home/costs/daily
GET /api/home/costs/responsibles
GET /api/home/athena
GET /api/datalake/buckets
GET /api/datalake/ingest
POST /api/datalake/ingest/scan
GET /api/datalake/ingest/detail
GET /api/datalake/ingest/records
POST /api/datalake/ingest/records/scan
POST /api/areas
PATCH /api/areas/{areaId}
DELETE /api/areas/{areaId}
POST /api/project-statuses
PATCH /api/project-statuses/{statusId}
DELETE /api/project-statuses/{statusId}
POST /api/people
PATCH /api/people/{personId}
DELETE /api/people/{personId}
POST /api/projects
PATCH /api/projects/{projectId}
DELETE /api/projects/{projectId}
POST /api/projects/{projectId}/members
PATCH /api/projects/{projectId}/members/{personId}
DELETE /api/projects/{projectId}/members/{personId}
POST /api/projects/{projectId}/tasks
PATCH /api/projects/{projectId}/tasks/{taskId}
DELETE /api/projects/{projectId}/tasks/{taskId}
POST /api/projects/{projectId}/updates
PATCH /api/projects/{projectId}/updates/{updateId}
DELETE /api/projects/{projectId}/updates/{updateId}
POST /api/projects/{projectId}/attachments/presign
POST /api/projects/{projectId}/attachments
GET /api/projects/{projectId}/attachments                      (carga diferida, 2026-07-31)
POST /api/projects/{projectId}/attachments/relate-folder       (relacionar carpeta, 2026-07-31)
POST /api/projects/{projectId}/deliverables                    (entregables, 2026-07-31)
PATCH|DELETE /api/projects/{projectId}/deliverables/{deliverableId}
GET /api/projects/{projectId}/attachments/{attachmentId}/url
PATCH /api/projects/{projectId}/attachments/{attachmentId}
DELETE /api/projects/{projectId}/attachments/{attachmentId}
GET /api/staff
POST /api/staff/people/{personId}/absences
PATCH /api/staff/people/{personId}/absences/{absenceId}
DELETE /api/staff/people/{personId}/absences/{absenceId}
PATCH /api/staff/people/{personId}/vacation-days
PATCH /api/staff/people/{personId}/notes
POST /api/staff/holidays
DELETE /api/staff/holidays/{date}
POST /api/staff/holidays/extract
GET /api/draw
GET /api/draw/users
POST /api/draw
PATCH /api/draw/{drawingId}
DELETE /api/draw/{drawingId}
GET /api/draw/{drawingId}/url
POST /api/draw/{drawingId}/save-url
GET /api/draw/{drawingId}/files/{fileId}/url
POST /api/draw/{drawingId}/files/{fileId}/save-url
POST /api/draw/{drawingId}/shares
DELETE /api/draw/{drawingId}/shares/{email}
POST /api/draw/{drawingId}/respond
GET /api/catalog/databases
GET /api/catalog/tables
GET /api/catalog/{database}/{table}
PUT /api/catalog/{database}/{table}/context
PUT /api/catalog/{database}/{table}/columns/{column}/context
GET /api/admin/users
POST /api/admin/users
PATCH /api/admin/users/{email}
DELETE /api/admin/users/{email}
GET /api/admin/audit
```

**Adjuntos: carpetas y carga diferida (2026-07-31):** el adjunto guarda su **ruta relativa** (`path`) y el árbol de la vista se deriva de ella — no hay entidad "carpeta" (ver `docs/04`); la ruta se valida contra `..`, 10 niveles y 400 caracteres, y NO entra en la llave de S3. `GET /attachments` devuelve la lista de UNA solicitud con el autor resuelto: la lista dejó de viajar en `/api/workspace` (solo va `attachmentsCount`) porque con carpetas de 50 archivos sumaba más de 1 MB a cada carga. `POST /attachments/relate-folder` relaciona **toda una carpeta** (y sus subcarpetas) con una entrada de seguimiento en una sola llamada — con 89 archivos, hacerlo uno por uno serían 89 peticiones; compara con `path == ruta or path.startswith(ruta + "/")`, la barra evita que «Reporte» arrastre a «Reporte2». El **zip de descarga se arma en el NAVEGADOR** (JSZip auto-hospedado en `/vendor/`), no en la Lambda: comprimir allá sería doble transferencia desde S3, cómputo por cada descarga y riesgo de timeout.

**Entregables (2026-07-31):** nivel opcional que agrupa tareas dentro de una solicitud; item `DELIVERABLE` colgado del PK del proyecto y campo `deliverableId` en la tarea, validado contra los entregables de SU solicitud. Borrar un entregable NO borra tareas: se les vacía el `deliverableId` y la respuesta dice cuántas quedaron sueltas (`tasksReleased`). Guard de `tasks`: es trabajo diario, no catálogo compartido.

**Adjuntos de solicitudes (2026-07-07):** el binario NUNCA pasa por la API (tope de 10 MB de API Gateway) — `presign` devuelve una URL prefirmada de subida (PUT directo del navegador a S3), `POST /attachments` confirma el archivo subido (`kind=file`) o crea una query de texto inline (`kind=query`), `GET …/url` devuelve una presigned GET corta para ver/descargar, `PATCH` cambia la relación (`updateId`: entrada de seguimiento o `""` = General) y `DELETE` borra item + binario. Validación en backend: **blocklist** de extensiones (2026-07-08: se acepta casi cualquier binario de trabajo — Excel, Word, parquet, zip…; se bloquean solo ejecutables/scripts y páginas activas html/svg, que ejecutan código al abrirse desde la presigned GET) y máx. 15 MB. Servicio: `services/attachments.py` (puerto BlobStore, adaptador S3 — bucket compartido `gad-storage-<env>` con prefijo por app).

**Personal (`/api/staff`, 2026-07-08):** ausencias del equipo + saldo de vacaciones sobre las personas del workspace. `GET /api/staff` lo puede llamar cualquier usuario autenticado **y configurado** (el servicio valida el perfil; no exige módulo — la vista se abre desde el menú del usuario); las rutas de escritura (ausencias y `vacation-days`) llevan **guard `admin=True`**. Validaciones: tipo en `vacation|leave|sick`, rango de fechas válido, sin traslapes por persona, días asignados 0-60. **Asuetos (2026-07-09, admin):** `POST /holidays` upsert masivo (misma ruta para el alta manual y la confirmación del extractor), `DELETE /{date}`, y `POST /holidays/extract` — recibe la imagen en base64 (≤5 MB PNG/JPG), la lee con Textract, GLM 5 la estructura y devuelve un BORRADOR (no guarda nada: la pantalla de confirmación editable decide).

**WebSocket de colaboración en vivo (Pizarra, 2026-07-08):** API aparte de la HTTP — `wss://…execute-api…/dev` (output `WebSocketUrl` del stack, publicado como `wsUrl` en `config.json`). Rutas `$connect` (valida el access token de Cognito por query param con `GetUser` + acceso al tablero por el modelo de compartir; 400 sin token, 401 inválido, 403 sin acceso), `$disconnect` y `$default` (mensajes `hello`/`init-response`/`scene`/`pointer` — el servidor solo releva a la sala). Atendida por la MISMA Lambda (ramifica por `routeKey` en `handler.py` → `services/draw_ws.py`); conexiones en DynamoDB con TTL; requiere `execute-api:ManageConnections` (grant en CDK). **Límite duro: 32 KB por frame y 128 KB por mensaje** — pasado de ahí el mensaje NO se entrega. Nada voluminoso (imágenes, escenas enteras) puede viajar por aquí: las imágenes van por S3 y los elementos se trocean por tamaño en el cliente. El relevo registra en CloudWatch lo que descarta por `PayloadTooLargeException` (antes se lo tragaba en silencio: así desaparecieron las imágenes pegadas hasta el 2026-07-31).

**Pizarra (`/api/draw`, 2026-07-07):** lienzo Excalidraw con compartir selectivo. Cada pizarra tiene dueño; `shares` invita usuarios concretos (estado `pending`) y el invitado responde con `respond` (`accept: true|false` — aceptar habilita ver/editar; rechazar borra el share). Solo el dueño renombra/elimina/comparte/revoca (`PermissionError` → 403). La escena (JSON `.excalidraw`, puede pesar MB) va a S3 vía `…/url` (cargar) y `save-url` (guardar con presigned PUT); metadata en DynamoDB. `GET /api/draw/users` lista usuarios de la app (correo + nombre) para el selector "Compartir con". **Imágenes (2026-07-31):** cada archivo pegado tiene ADEMÁS su objeto propio en `drawings/{id}/files/{fileId}.json` (el `BinaryFileData` de Excalidraw tal cual), con el mismo par de rutas `…/files/{fileId}/url` y `…/files/{fileId}/save-url` y el mismo permiso que la escena; el `fileId` lo inventa el navegador y se valida contra `[A-Za-z0-9_-]{1,64}` porque termina siendo parte de la llave en S3. Motivo: por el WebSocket solo puede viajar el `fileId` — el base64 no cabe en un mensaje de API Gateway (ver más abajo y `docs/22`). Al eliminar la pizarra se borra también ese prefijo.

## Permisos

Cada endpoint debe llamar una funcion comun de autorizacion antes de ejecutar la accion. El permiso debe considerar usuario, modulo, proyecto y recurso afectado.

En el primer corte de proyectos y tareas, las rutas de workspace validan que el usuario tenga habilitado el módulo `projects` o `tasks` antes de operar.

Las rutas de edición del panel de detalle validan permisos en backend:

- `projects` para editar personas, proyectos y roles de miembros.
- `projects` para quitar personas de proyectos.
- `tasks` para editar tareas.

En proyectos y tareas, los campos `ownerPersonId`, `assigneePersonId`, `project.status` y `task.priority` aceptan una cadena vacía para representar `Ninguno` o `Ninguna`. El backend conserva estos valores como opcionales y aplica únicamente los valores enviados por el usuario.

Si un usuario no tiene módulos funcionales configurados, el backend debe rechazar la operación con `403`.

## Auditoria

Registrar como minimo:

- Cambios de permisos.
- Creacion y edicion de proyectos.
- Cambios de estado de tareas.
- Cambios de prioridad de tareas.
- Cambios de responsable de tareas.
- Cambios de contexto funcional.
- Acciones administrativas.
