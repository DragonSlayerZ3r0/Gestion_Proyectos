# API backend

## Tecnologia base

- API Gateway.
- Lambda Python.
- DynamoDB para datos operativos.
- Boto3 para integraciones AWS.
- Respuestas JSON estandar.

## Estructura Lambda sugerida

```text
backend/
  app/
    handler.py
    router.py
    auth.py
    permissions.py
    responses.py
    errors.py
    audit.py
    services/
      users.py
      projects.py
      tasks.py
      catalog.py
      admin.py
    repositories/
      dynamodb.py
```

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
POST /api/people
PATCH /api/people/{personId}
POST /api/projects
PATCH /api/projects/{projectId}
POST /api/projects/{projectId}/members
PATCH /api/projects/{projectId}/members/{personId}
DELETE /api/projects/{projectId}/members/{personId}
POST /api/projects/{projectId}/tasks
PATCH /api/projects/{projectId}/tasks/{taskId}
GET /api/catalog/databases
GET /api/catalog/tables
GET /api/catalog/{database}/{table}
PUT /api/catalog/{database}/{table}/context
PUT /api/catalog/{database}/{table}/columns/{column}/context
GET /api/admin/users
PUT /api/admin/users/{userId}/modules
GET /api/admin/audit
```

## Permisos

Cada endpoint debe llamar una funcion comun de autorizacion antes de ejecutar la accion. El permiso debe considerar usuario, modulo, proyecto y recurso afectado.

En el primer corte de proyectos y tareas, las rutas de workspace validan que el usuario tenga habilitado el módulo `projects` o `tasks` antes de operar.

Las rutas de edición del panel de detalle validan permisos en backend:

- `projects` para editar personas, proyectos y roles de miembros.
- `projects` para quitar personas de proyectos.
- `tasks` para editar tareas.

En proyectos y tareas, los campos `ownerPersonId`, `assigneePersonId`, `project.status` y `task.priority` pueden enviarse como cadena vacía para representar `Ninguno` o `Ninguna`. El backend no debe imponer responsable, prioridad de tarea ni estado de proyecto por defecto.

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
