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

## Auditoría

La vista de auditoría debe permitir revisar acciones sensibles. Al inicio puede filtrar por fecha, usuario, tipo de entidad y acción.
