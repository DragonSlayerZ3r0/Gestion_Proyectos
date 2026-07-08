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

- `backend/app/services/admin.py` (`AdminService`): `list_users`, `create_user`, `update_user`, `delete_user`. La clave del usuario es su **email** en minúsculas (`USER#<email>`), igual que `auth.get_user_identity`.
- Datos en DynamoDB: `USER#<email> / PROFILE` (campos `email`, `name`, `roles`, `status`) y un item por módulo `USER#<email> / MODULE#<key>` (`enabled`, `label`). El módulo `home` siempre se incluye. El catálogo asignable sale del manifiesto (`MODULES + HOME_TABS`); `create_user`/`update_user` escriben **todo** el catálogo con su flag `enabled` para que la resolución sea determinista.
- **Pestañas de Inicio**: además de los módulos de menú, se pueden asignar las pestañas del módulo Panel como permisos granulares (`home_datalake`, `home_facturacion`, `home_athena`, ver `modules/manifest.py → HOME_TABS`). Se guardan como filas `MODULE#` y se exponen en `GET /api/me` dentro de `homeTabs`. La pestaña **Resumen se retiró** (2026-07-06): su clave `home_resumen` vive en `RETIRED_HOME_TAB_KEYS` y se sigue excluyendo del menú aunque quede guardada por usuario (`_MENU_EXCLUDE_KEYS` en `services/users.py`). Facturación/Athena tienen default admin-only cuando la clave no está configurada.
- Rol: `roles` contiene `["admin","user"]` (administrador) o `["user"]` (normal).
- Guard `ensure_admin(identity)` en `handler.py`: exige rol `admin` **y** estado `active`; se valida en backend, no solo ocultando el módulo en el frontend.
- Rutas (todas bajo JWT Authorizer + `ensure_admin`):

| Ruta | Método | Función |
| --- | --- | --- |
| `/api/admin/users` | GET | Listar usuarios con rol, estado y módulos |
| `/api/admin/users` | POST | Crear perfil funcional (email, nombre, rol, módulos) |
| `/api/admin/users/{email}` | PATCH | Editar nombre, rol, estado y módulos |
| `/api/admin/users/{email}` | DELETE | Eliminar perfil y todos sus accesos (con guard de auto-eliminación) |

### Frontend

`renderAdmin()` en `frontend/src/scripts/modules/admin.ts`: lista de usuarios donde cada tarjeta está **colapsada** — el resumen de acceso son **chips** (2026-07-08): neutros para módulos normales y con color SOLO en lo que implica privilegio (rol **Administrador** = acento verde; módulo **Administración** = ámbar `--warn-soft`), para escanear de un vistazo quién puede administrar sin caer en un arcoíris sin significado (disciplina de color, estándar #4 de docs/06) y se edita con el **ícono de lápiz**; dentro de la edición se despliegan nombre, rol, estado, casillas de módulos (con sub-casillas para las pestañas de Inicio: Resumen y Data Lake) y el **ícono de eliminar**. Incluye formulario de alta. El módulo solo es funcional para usuarios con rol `admin`.

### Pendiente

- Creación del usuario en Cognito desde el módulo (hoy manual; se decidió mantener solo autorización en DynamoDB).
- Auditoría (abajo).

## Auditoría

La vista de auditoría debe permitir revisar acciones sensibles. Al inicio puede filtrar por fecha, usuario, tipo de entidad y acción.
