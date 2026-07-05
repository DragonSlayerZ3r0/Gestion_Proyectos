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
