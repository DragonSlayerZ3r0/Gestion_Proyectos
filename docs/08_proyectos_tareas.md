# Proyectos y tareas

## Experiencia objetivo

La gestión de proyectos y tareas debe concentrarse en una pantalla de trabajo simple. El usuario debe poder crear una persona, crear un proyecto, agregar personas al proyecto y crear tareas sin navegar por varias pantallas.

La pantalla debe sentirse como un tablero operativo liviano, no como Jira. El flujo principal debe permitir:

- Crear usuario rápido con nombre y apellido como campos mínimos.
- Completar datos opcionales solo si el usuario los necesita: área, notas, vacaciones u observaciones.
- Buscar usuarios existentes y arrastrarlos hacia un proyecto.
- Crear proyecto rápido con nombre, responsable opcional y estado inicial.
- Crear tareas rápidas dentro del proyecto con título como dato mínimo.
- Arrastrar tareas entre estados.
- Arrastrar usuarios hacia tareas para asignar responsable.
- Abrir formularios de usuario y tarea solo cuando el usuario presione `Crear`, para mantener limpia la mesa de trabajo.
- Abrir detalle de tarea solo mediante un botón pequeño de `Detalle`, no al seleccionar o arrastrar la tarjeta.

Regla de navegación: no separar `Proyectos` y `Tareas` en dos ventanas del menú. El usuario debe entenderlo como una sola mesa de trabajo: seleccionar proyecto, ver sus tareas, crear personas y asignarlas en el mismo lugar.

## Pantalla de trabajo sugerida

La pantalla principal debe dividirse en tres zonas claras:

- Personas: panel lateral con buscador, botón de creación rápida y lista de usuarios disponibles.
- Proyectos: zona central con proyectos activos y botón de nuevo proyecto.
- Tareas: tablero del proyecto seleccionado con columnas simples.

El usuario no debe llenar formularios largos para empezar. Los detalles extendidos se editan desde un panel contextual cuando haga falta, sin cubrir el tablero ni abrirse automáticamente.

## Panel de detalle

La pantalla incluye un panel contextual. El panel se abre por acción explícita en una persona, proyecto o tarea, y permite editar los campos principales sin cambiar de ventana.

- Persona: nombre, apellido, área, notas, vacaciones/disponibilidad y estado.
- Proyecto: nombre, descripción, estado, responsable y roles de miembros.
- Tarea: título, estado, prioridad, responsable y notas.

El panel debe complementar la creación rápida y el drag and drop, no reemplazarlos.

## Creación rápida de usuarios

Campos mínimos:

- Nombre.
- Apellido.

Campos opcionales:

- Área.
- Notas.
- Días de vacaciones u observaciones de disponibilidad.
- Estado activo/inactivo.

Si el usuario ya existe, debe poder encontrarse por buscador y agregarse al proyecto mediante drag and drop o botón directo.

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

Todo cambio de prioridad debe registrarse en auditoría.

## Comentarios

Los comentarios deben quedar asociados a la tarea y registrar autor, fecha y contenido.
