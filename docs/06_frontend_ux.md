# Frontend y UX

Nota de idioma: aunque se mantenga el término técnico `frontend`, toda la experiencia visible debe estar en español. Títulos, botones, mensajes, labels, estados vacíos y errores deben usar español claro y consistente.

## Principio de experiencia

Interfaz simple, pocos botones, pantallas limpias y sin sobrecargar al usuario.

La aplicación no debe parecer Jira. Debe sentirse como una herramienta interna clara, directa y liviana.

La primera pantalla debe orientar sin convertirse en landing page: mostrar estado de sesión, módulos disponibles, estado del ambiente y próximos pasos operativos. Los módulos iniciales pueden usar paneles informativos mientras no exista CRUD completo, pero deben verse como una aplicación funcional y no como placeholders descuidados.

## Layout general

- Menú lateral con módulos habilitados.
- Header con nombre de usuario, ambiente y acción de salida.
- Área principal enfocada en la tarea actual.
- Estados vacíos claros y accionables.
- Tablas densas pero legibles.

## Menú lateral

El menú se construye desde la respuesta de `GET /api/me`. Solo debe mostrar módulos habilitados para el usuario.

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

## Menú dinámico por permisos

El frontend debe consumir permisos calculados desde backend. No debe codificar permisos sensibles solo en cliente.
