# Proyectos y tareas

> **Naturaleza de este documento:** describe el **diseño objetivo** (especificación funcional/UX) del módulo. Para el **estado realmente implementado y desplegado**, ver [`docs/15_estado_implementacion.md`](15_estado_implementacion.md).

## Experiencia objetivo

La gestión de proyectos y tareas se concentra en una pantalla de trabajo simple. Desde ella, el usuario crea personas y proyectos, agrega integrantes y administra tareas.

La pantalla funciona como una vista general de proyectos con sus personas y tareas relacionadas. El flujo principal permite:

- Registrar persona rápido con nombre y apellido como campos mínimos.
- Completar datos opcionales solo si el usuario los necesita: área, notas, vacaciones u observaciones.
- Buscar proyectos y tareas desde un mismo input con alcance seleccionable: `Proyectos`, `Tareas` o ambos.
- Buscar personas desde una búsqueda independiente en la franja `Personas registradas`.
- Crear proyecto rápido con nombre; responsable y estado son opcionales.
- Ver cada proyecto como una tarjeta con responsable, personas relacionadas, resumen de tareas y tareas principales.
- Agregar personas desde la tarjeta del proyecto.
- Editar una persona desde la franja `Personas registradas`, usando el ícono de lápiz, para actualizar área, estado, notas o vacaciones/disponibilidad.
- Crear tareas rápidas dentro del proyecto con título como dato mínimo.
- Arrastrar tareas entre estados.
- Asignar o cambiar responsable de tarea desde la acción explícita `Asignar` o `Cambiar`, usando el selector `Responsable` del panel de detalle.
- Filtrar proyectos por estado desde la parte superior del listado, mostrando todos por defecto.
- Mostrar el estado actual dentro de cada tarjeta de proyecto solo si fue definido.
- Usar colores contextuales para estado de proyecto, estado de tarea y prioridad cuando existan.
- Abrir formularios de persona y tarea solo cuando el usuario presione `Registrar persona` o `Crear tarea`, para mantener limpia la mesa de trabajo.
- Abrir la edición de una tarea mediante su ícono de lápiz; seleccionar o arrastrar conserva el contexto operativo.
- Mostrar confirmación visible al guardar cambios de proyecto o tarea desde el panel de detalle.
- Mostrar confirmación breve al registrar persona, crear proyecto o crear tarea.

Nota de lenguaje: en esta pantalla se usa `persona` para integrantes operativos que pueden participar en proyectos y tareas. `Usuario` queda reservado para cuentas de acceso a la aplicación web, autenticación, perfiles y administración.

Regla de navegación: `Proyectos y tareas` es una sola entrada del menú y una sola mesa de trabajo. Cada tarjeta reúne proyecto, responsable, personas y tareas.

## Pantalla de trabajo sugerida

La pantalla principal debe tener una jerarquía directa:

- Barra superior: búsqueda de proyectos/tareas con alcance seleccionable, creación de proyecto, registro secundario de persona y filtros de estado.
- Lista de proyectos: cada tarjeta muestra responsable, descripción (bajo el título, si existe), personas relacionadas y resumen de tareas por estado (conteos).
- Tablero: comienza como resumen de conteos y se abre dentro del proyecto mediante `Ver tablero` para mostrar el Kanban completo; `Ocultar tablero` restaura el resumen.

La creación rápida solicita los campos mínimos. Los detalles extendidos se editan desde un panel contextual abierto por una acción explícita. En escritorio aparece como panel lateral derecho no modal alineado con el elemento; en móvil, como bottom sheet con scroll interno.

Las personas aparecen dentro del proyecto donde participan y en la franja compacta `Personas registradas`. El menú lateral puede contraerse para liberar espacio horizontal durante el trabajo operativo.

## Panel de detalle

La pantalla incluye un panel contextual. El panel se abre por acción explícita en una persona, proyecto o tarea, y permite editar los campos principales sin cambiar de ventana.

- Persona: nombre, apellido, área, estado opcional, notas y vacaciones/disponibilidad. Este panel debe ser fácil de abrir desde la franja `Personas registradas`, por ejemplo para marcar a alguien como inactivo o actualizar que ya regresó de vacaciones.
- Proyecto: nombre, descripción, estado opcional, responsable opcional y roles de miembros.
- Tarea: título, estado, prioridad opcional, responsable opcional y notas.

El panel complementa la creación rápida y el drag and drop. Para tareas, constituye la vía principal para asignar, cambiar o quitar responsable.

Los textos de acción deben ser consistentes: `Crear` para altas rápidas, `Editar` para abrir edición, `Guardar` para persistir cambios y `Cancelar` para abandonar una creación rápida.

## Registro rápido de personas

Campos mínimos:

- Nombre.
- Apellido.

Campos opcionales:

- Área.
- Notas.
- Días de vacaciones u observaciones de disponibilidad.
- Estado activo/inactivo.
- El estado puede quedar en `Ninguno`; la tarjeta omite el badge en ese caso.

Si la persona ya existe, debe poder agregarse al proyecto desde el selector de personas de la tarjeta del proyecto.

Si la persona ya está en el proyecto, se muestra como persona relacionada dentro de la tarjeta correspondiente.

La búsqueda principal filtra proyectos y tareas; `Buscar persona` filtra la franja de personas y el selector `Agregar persona` conserva las opciones disponibles.

## Proyectos

El modulo debe permitir:

- Crear proyectos.
- Editar proyectos.
- Consultar detalle de proyecto.
- Asignar personas.
- Definir responsable.
- Asociar tablas del Data Lake.
- Configurar modo de acceso al proyecto.

## Estados de proyecto

Estados iniciales sugeridos:

- Ninguno.
- Planificado.
- Activo.
- Pausado.
- Cerrado.

El estado del proyecto es opcional. Si el usuario selecciona `Ninguno`, la tarjeta omite el badge de estado.

## Personas del proyecto

Una persona puede participar en un proyecto con un rol funcional:

- Responsable.
- Miembro.
- Lector.

## Modo de acceso por proyecto

El proyecto puede definir si la incorporacion de usuarios es:

- Manual por responsable.
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

- Ninguna.
- Baja.
- Media.
- Alta.
- Critica.

La prioridad es opcional. Si el usuario selecciona `Ninguna`, la tarea omite el badge de prioridad.

## Regla de prioridad

La prioridad de una tarea puede cambiarse en cualquier momento si el usuario tiene permiso.

La prioridad y el estado evolucionan de forma independiente. Una tarea puede cambiar de prioridad en cualquier estado.

Todo cambio de prioridad debe registrarse en auditoría.

## Comentarios

Los comentarios deben quedar asociados a la tarea y registrar autor, fecha y contenido.
