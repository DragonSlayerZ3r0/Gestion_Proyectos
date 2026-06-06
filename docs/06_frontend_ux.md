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

El menú debe reducir navegación innecesaria. Si el usuario tiene permisos de `projects` o `tasks`, el frontend debe mostrar una sola entrada llamada `Proyectos y tareas`, porque ambas acciones pertenecen a la misma mesa de trabajo.

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
- En `Proyectos y tareas`, los formularios de creación de usuarios y tareas deben estar colapsados por defecto y abrirse solo cuando el usuario presione `Crear`.

## Login

El login visible al usuario debe estar en español y dentro de la experiencia de la aplicación. La ventana de credenciales debe incluir:

- Campo de correo.
- Campo de contraseña.
- Acción principal para ingresar.
- Acción secundaria para cancelar y volver a la pantalla anterior sin iniciar sesión.
- Mensajes claros para credenciales incorrectas, usuario no configurado y cambio de contraseña inicial.

Si Cognito exige cambio de contraseña inicial, el formulario debe mostrar el campo de nueva contraseña en el mismo flujo, sin enviar al usuario a una pantalla externa en inglés.

## Modales

Usarlos para acciones cortas. Evitar formularios largos en modales si una pantalla dedicada es mas clara.

## Drag and drop

Usar drag and drop solo donde aporte valor claro, especialmente en tareas por estado. Debe existir alternativa accesible por controles directos.

Para proyectos y tareas, drag and drop debe usarse en acciones que el usuario entienda visualmente:

- Arrastrar una persona hacia un proyecto para agregarla como miembro.
- Arrastrar una persona hacia una tarea para asignarla como responsable.
- Arrastrar una tarea entre columnas de estado.
- Reordenar tareas dentro de una columna solo si aporta claridad.

Cada acción drag and drop debe tener una alternativa visible: botón `Agregar`, menú de responsable o selector de estado. El sistema no debe depender exclusivamente del arrastre.

## Pantalla de proyectos y tareas

La pantalla principal debe permitir trabajar sin cambiar de contexto:

- Panel de personas con búsqueda y creación rápida.
- Lista o tablero de proyectos con selección clara del proyecto activo.
- Kanban simple de tareas del proyecto seleccionado.
- Panel de detalles para editar usuario, proyecto o tarea sin salir de la pantalla.

Esta pantalla debe ser la entrada operativa predeterminada cuando el usuario tenga acceso a proyectos o tareas. Evitar abrir Administración o Catálogo como primera vista solo por orden alfabético de permisos.

El panel de detalle debe permanecer dentro de la misma pantalla, sin tapar el tablero ni bloquear el trabajo del usuario. No debe abrirse automáticamente al seleccionar una tarjeta; debe abrirse solo con una acción explícita como `Editar` o `Detalle`.

La creación rápida debe pedir solo lo mínimo:

- Usuario: nombre y apellido.
- Proyecto: nombre.
- Tarea: título.

Los campos adicionales deben quedar disponibles como detalle opcional, no como requisito para crear.

## Kanban simple

Estados sugeridos:

- Pendiente.
- En progreso.
- En revision.
- Completada.

El Kanban no debe incorporar configuraciones complejas al inicio.

## Menú dinámico por permisos

El frontend debe consumir permisos calculados desde backend. No debe codificar permisos sensibles solo en cliente.
