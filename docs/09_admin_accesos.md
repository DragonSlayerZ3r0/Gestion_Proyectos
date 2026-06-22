# Administración y accesos

## Objetivo

Permitir que usuarios administradores gestionen accesos funcionales globales, usuarios y auditoría inicial.

## Alcance inicial del administrador

El admin inicialmente solo gestiona accesos globales.

La asignación a proyectos puede hacerla el responsable de proyecto o el usuario mediante autoasignación, según configuración del proyecto.

## Que puede ver el admin

- Usuarios funcionales.
- Estado de activación.
- Módulos habilitados por usuario.
- Roles globales.
- Eventos de auditoría.

## Que puede modificar el admin

- Activar o desactivar usuarios funcionales.
- Habilitar o deshabilitar módulos por usuario.
- Asignar roles globales.
- Revisar actividad administrativa.

## Gestión de módulos por usuario

Cada módulo debe tener una clave estable, por ejemplo:

```text
home
projects
tasks
catalog
dashboards
requests
admin
```

## Estado implementado (MVP)

El módulo `admin` ya permite gestionar la **autorización** de usuarios desde la plataforma (la **autenticación** sigue en Cognito: el usuario debe existir antes ahí). Cognito = "quién eres"; DynamoDB = "qué puedes ver/hacer". Crear un usuario solo en Cognito produce la pantalla **"Acceso pendiente"** hasta que el admin le crea el perfil.

### Backend

- `backend/app/services/admin.py` (`AdminService`): `list_users`, `create_user`, `update_user`. La clave del usuario es su **email** en minúsculas (`USER#<email>`), igual que `auth.get_user_identity`.
- Datos en DynamoDB: `USER#<email> / PROFILE` (campos `email`, `name`, `roles`, `status`) y un item por módulo `USER#<email> / MODULE#<key>` (`enabled`, `label`). El módulo `home` siempre se incluye.
- Rol: `roles` contiene `["admin","user"]` (administrador) o `["user"]` (normal).
- Guard `ensure_admin(identity)` en `handler.py`: exige rol `admin` **y** estado `active`; se valida en backend, no solo ocultando el módulo en el frontend.
- Rutas (todas bajo JWT Authorizer + `ensure_admin`):

| Ruta | Método | Función |
| --- | --- | --- |
| `/api/admin/users` | GET | Listar usuarios con rol, estado y módulos |
| `/api/admin/users` | POST | Crear perfil funcional (email, nombre, rol, módulos) |
| `/api/admin/users/{email}` | PATCH | Editar rol, estado y módulos |

### Frontend

`renderAdmin()` en `frontend/src/scripts/app.ts`: lista de usuarios con selector de rol/estado y casillas de módulos por usuario (guardado por tarjeta), más un formulario de alta. El módulo solo es funcional para usuarios con rol `admin`.

### Pendiente

- Creación del usuario en Cognito desde el módulo (hoy manual; se decidió mantener solo autorización en DynamoDB).
- Auditoría (abajo).

## Auditoría

La vista de auditoría debe permitir revisar acciones sensibles. Al inicio puede filtrar por fecha, usuario, tipo de entidad y acción.
