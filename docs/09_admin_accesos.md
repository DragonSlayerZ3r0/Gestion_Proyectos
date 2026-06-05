# Administracion y accesos

## Objetivo

Permitir que usuarios administradores gestionen accesos funcionales globales, usuarios y auditoria inicial.

## Alcance inicial del administrador

El admin inicialmente solo gestiona accesos globales.

La asignacion a proyectos puede hacerla el project owner o el usuario mediante autoasignacion, segun configuracion del proyecto.

## Que puede ver el admin

- Usuarios funcionales.
- Estado de activacion.
- Modulos habilitados por usuario.
- Roles globales.
- Eventos de auditoria.

## Que puede modificar el admin

- Activar o desactivar usuarios funcionales.
- Habilitar o deshabilitar modulos por usuario.
- Asignar roles globales.
- Revisar actividad administrativa.

## Gestion de modulos por usuario

Cada modulo debe tener una clave estable, por ejemplo:

```text
home
projects
tasks
catalog
dashboards
requests
admin
```

## Auditoria

La vista de auditoria debe permitir revisar acciones sensibles. Al inicio puede filtrar por fecha, usuario, tipo de entidad y accion.
