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
GET /api/projects
POST /api/projects
GET /api/projects/{id}
PUT /api/projects/{id}
GET /api/projects/{id}/tasks
POST /api/projects/{id}/tasks
PUT /api/projects/{id}/tasks/{taskId}
POST /api/projects/{id}/join
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

## Auditoria

Registrar como minimo:

- Cambios de permisos.
- Creacion y edicion de proyectos.
- Cambios de estado de tareas.
- Cambios de prioridad de tareas.
- Cambios de contexto funcional.
- Acciones administrativas.
