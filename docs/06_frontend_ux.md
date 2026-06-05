# Frontend y UX

## Principio de experiencia

Interfaz simple, pocos botones, pantallas limpias y sin sobrecargar al usuario.

La aplicacion no debe parecer Jira. Debe sentirse como una herramienta interna clara, directa y liviana.

## Layout general

- Menu lateral con modulos habilitados.
- Header con nombre de usuario, ambiente y accion de salida.
- Area principal enfocada en la tarea actual.
- Estados vacios claros y accionables.
- Tablas densas pero legibles.

## Menu lateral

El menu se construye desde la respuesta de `GET /api/me`. Solo debe mostrar modulos habilitados para el usuario.

Ocultar opciones no reemplaza seguridad backend.

## Pantalla Inicio

Debe mostrar:

- Proyectos recientes.
- Tareas asignadas.
- Tareas proximas o vencidas.
- Accesos disponibles.
- Actividad reciente relevante.

## Tablas

- Columnas esenciales.
- Acciones claras.
- Filtros simples.
- Busqueda cuando haya volumen.
- Evitar tablas con demasiada informacion por fila.

## Formularios

- Campos minimos necesarios.
- Validacion visible.
- Mensajes claros.
- Guardado evidente.

## Modales

Usarlos para acciones cortas. Evitar formularios largos en modales si una pantalla dedicada es mas clara.

## Drag and drop

Usar drag and drop solo donde aporte valor claro, especialmente en tareas por estado. Debe existir alternativa accesible por controles directos.

## Kanban simple

Estados sugeridos:

- Pendiente.
- En progreso.
- En revision.
- Completada.

El Kanban no debe incorporar configuraciones complejas al inicio.

## Menu dinamico por permisos

El frontend debe consumir permisos calculados desde backend. No debe codificar permisos sensibles solo en cliente.
