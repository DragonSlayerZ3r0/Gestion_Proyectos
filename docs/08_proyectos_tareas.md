# Proyectos y tareas

> **Naturaleza de este documento:** describe el **diseño objetivo** (especificación funcional/UX) del módulo. Para el **estado realmente implementado y desplegado**, ver [`docs/15_estado_implementacion.md`](15_estado_implementacion.md).

## Experiencia objetivo

La gestión de proyectos y tareas debe concentrarse en una pantalla de trabajo simple. El usuario debe poder crear una persona, crear un proyecto, agregar personas al proyecto y crear tareas sin navegar por varias pantallas.

La pantalla debe sentirse como una vista general de proyectos con tareas visibles, no como Jira. El flujo principal debe permitir:

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
- Abrir edición de tarea solo mediante un ícono de lápiz, no al seleccionar o arrastrar la tarjeta.
- Mostrar confirmación visible al guardar cambios de proyecto o tarea desde el panel de detalle.
- Mostrar confirmación breve al registrar persona, crear proyecto o crear tarea.

Nota de lenguaje: en esta pantalla se usa `persona` para integrantes operativos que pueden participar en proyectos y tareas. `Usuario` queda reservado para cuentas de acceso a la aplicación web, autenticación, perfiles y administración.

Regla de navegación: no separar `Proyectos` y `Tareas` en dos ventanas del menú. El usuario debe entenderlo como una sola mesa de trabajo: ver proyecto, responsable, personas y tareas en la misma tarjeta.

## Pantalla de trabajo sugerida

La pantalla principal debe tener una jerarquía directa:

- Barra superior: búsqueda de proyectos/tareas con alcance seleccionable, creación de proyecto, registro secundario de persona y filtros de estado.
- Lista de proyectos: cada tarjeta muestra responsable, descripción (bajo el título, si existe), personas relacionadas y resumen de tareas por estado (conteos).
- Tablero: oculto por defecto; se abre solo dentro del proyecto cuando el usuario presiona `Ver tablero` (Kanban completo con drag-and-drop) y se cierra con `Ocultar tablero`. Sin abrirlo, la tarjeta solo muestra el resumen de conteos, no las tareas, para no aparentar un tablero duplicado.

El usuario no debe llenar formularios largos para empezar. Los detalles extendidos se editan desde un panel contextual cuando haga falta, sin cubrir el tablero ni abrirse automáticamente. En escritorio, el detalle debe abrirse como panel lateral derecho no modal alineado con el proyecto o tarea seleccionada; en móvil, como bottom sheet con scroll interno.

No debe existir un panel lateral fijo de `Personas / Equipo disponible` como bloque principal. Las personas deben verse dentro del proyecto donde participan. El menú lateral puede contraerse para liberar espacio horizontal durante el trabajo operativo.

## Panel de detalle

La pantalla incluye un panel contextual. El panel se abre por acción explícita en una persona, proyecto o tarea, y permite editar los campos principales sin cambiar de ventana.

- Persona: nombre, apellido, área, estado opcional, notas y vacaciones/disponibilidad. Este panel debe ser fácil de abrir desde la franja `Personas registradas`, por ejemplo para marcar a alguien como inactivo o actualizar que ya regresó de vacaciones.
- Proyecto: nombre, descripción, estado opcional, responsable opcional y roles de miembros.
- Tarea: título, estado, prioridad opcional, responsable opcional y notas.

El panel debe complementar la creación rápida y el drag and drop, no reemplazarlos. Para tareas, el panel es la vía principal para asignar, cambiar o quitar responsable.

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
- El estado puede quedar en `Ninguno`; en ese caso no se muestra ningún badge en la tarjeta.

Si la persona ya existe, debe poder agregarse al proyecto desde el selector de personas de la tarjeta del proyecto.

Si la persona ya está en el proyecto, debe mostrarse como persona relacionada dentro de la tarjeta del proyecto. No debe agregarse un panel lateral fijo ni un cuadro visible adicional que quite espacio al listado.

La búsqueda principal de proyectos y tareas no debe ocultar la franja de personas registradas ni afectar el selector `Agregar persona`. Las personas se filtran únicamente desde el campo `Buscar persona`.

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

El estado del proyecto no es obligatorio. Si el usuario selecciona `Ninguno`, no debe mostrarse badge de estado en la tarjeta.

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

La prioridad no es obligatoria. Si el usuario selecciona `Ninguna`, la tarea no debe mostrar badge de prioridad.

## Regla de prioridad

La prioridad de una tarea puede cambiarse en cualquier momento si el usuario tiene permiso.

La prioridad no debe bloquear el cambio de estado. Una tarea puede cambiar de prioridad aunque este pendiente, en progreso, en revision o completada.

Todo cambio de prioridad debe registrarse en auditoría.

## Comentarios

Los comentarios deben quedar asociados a la tarea y registrar autor, fecha y contenido.
