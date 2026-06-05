# Proyectos y tareas

## Proyectos

El modulo debe permitir:

- Crear proyectos.
- Editar proyectos.
- Consultar detalle de proyecto.
- Asignar usuarios.
- Definir project owner.
- Asociar tablas del Data Lake.
- Configurar modo de acceso al proyecto.

## Estados de proyecto

Estados iniciales sugeridos:

- Planificado.
- Activo.
- Pausado.
- Cerrado.

## Usuarios del proyecto

Un usuario puede participar en un proyecto con un rol funcional:

- Owner.
- Miembro.
- Lector.

## Modo de acceso por proyecto

El proyecto puede definir si la incorporacion de usuarios es:

- Manual por project owner.
- Autoasignacion solicitada por el usuario.
- Restringida por administrador.

## Tareas

El modulo de tareas debe permitir:

- Crear tareas.
- Editar tareas.
- Cambiar estado.
- Cambiar prioridad.
- Asignar responsable.
- Agregar comentarios.
- Mover entre columnas de Kanban.

## Estados de tareas

- Pendiente.
- En progreso.
- En revision.
- Completada.

## Prioridades

Prioridades recomendadas:

- Baja.
- Media.
- Alta.
- Critica.

## Regla de prioridad

La prioridad de una tarea puede cambiarse en cualquier momento si el usuario tiene permiso.

La prioridad no debe bloquear el cambio de estado. Una tarea puede cambiar de prioridad aunque este pendiente, en progreso, en revision o completada.

Todo cambio de prioridad debe registrarse en auditoria.

## Comentarios

Los comentarios deben quedar asociados a la tarea y registrar autor, fecha y contenido.
