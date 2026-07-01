# Frontend y UX

> **Naturaleza de este documento:** describe el **diseño objetivo** (especificación de UX). Para el **estado realmente implementado** (p. ej. la pantalla Inicio hoy es un dashboard con pestañas Resumen/Facturación), ver [`docs/02_modulos_funcionales.md`](02_modulos_funcionales.md) y [`docs/15_estado_implementacion.md`](15_estado_implementacion.md). La estructura de código del frontend (shell + módulos) está en [`docs/18_servicios_y_runtime.md`](18_servicios_y_runtime.md).

Nota de idioma: aunque se mantenga el término técnico `frontend`, toda la experiencia visible debe estar en español. Títulos, botones, mensajes, labels, estados vacíos y errores deben usar español claro y consistente.

## Principio de experiencia

La interfaz utiliza pocos botones, pantallas limpias y una carga visual controlada.

La aplicación se presenta como una herramienta interna clara, directa y liviana, centrada en las operaciones cotidianas del equipo.

La primera pantalla orienta mediante el estado de sesión, los módulos disponibles, el ambiente y los próximos pasos operativos. Durante la evolución de un módulo, sus paneles informativos muestran estado y acciones reales del sistema.

## Layout general

- Menú lateral con módulos habilitados.
- Header con ambiente y un menú de usuario tipo avatar (ícono circular, patrón estándar de apps web): al pulsarlo despliega el correo de la cuenta y la acción `Salir`. El menú se cierra al hacer clic fuera o con `Escape`.
- Área principal enfocada en la tarea actual.
- Estados vacíos claros y accionables.
- Tablas densas pero legibles.
- En pantallas operativas densas, el menú lateral debe poder contraerse para liberar espacio de trabajo.

## Menú lateral

El menú se construye desde la respuesta de `GET /api/me`. Solo debe mostrar módulos habilitados para el usuario.

El backend constituye la fuente de autorización; el menú refleja los permisos ya calculados.

El menú debe reducir navegación innecesaria. Si el usuario tiene permisos de `projects` o `tasks`, el frontend debe mostrar una sola entrada llamada `Proyectos y tareas`, porque ambas acciones pertenecen a la misma mesa de trabajo.

El módulo activo se persiste en `sessionStorage` (`gestionProyectosModule`): al recargar la página con sesión vigente, el usuario vuelve al módulo donde estaba (si sigue habilitado para él) en lugar del módulo por defecto. La preferencia se limpia al cerrar sesión. La sesión Cognito también vive en `sessionStorage` (`gestionProyectosAuth`), por lo que al recargar se ve brevemente la pantalla de acceso mientras se valida.

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
- Cada fila presenta la información esencial y lleva el detalle a una vista contextual.

## Formularios

- Campos minimos necesarios.
- Validacion visible.
- Mensajes claros.
- Guardado evidente.
- En `Proyectos y tareas`, los formularios de registro de personas y creación de tareas deben estar colapsados por defecto y abrirse solo cuando el usuario presione `Registrar persona` o `Crear tarea`. Si el usuario abandona una creación rápida, la acción debe llamarse `Cancelar`, cerrar el formulario y limpiar sus campos.

## Login

La vista principal previa a la autenticación muestra únicamente la portada de acceso. El menú, los módulos, los tableros y el contenido operativo se habilitan después de validar la sesión.

La portada de acceso debe mostrar solamente:

- Marca de la plataforma.
- Mensaje breve de acceso interno.
- Ambiente actual.
- Acción principal `Ingresar`.

En pantallas anchas, los bloques de marca e ingreso forman una unidad centrada con ancho máximo y márgenes laterales equilibrados.

El login visible al usuario debe estar en español. La ventana de credenciales debe incluir:

- Campo de correo.
- Campo de contraseña.
- Acción principal para ingresar.
- Acción secundaria para cancelar y volver a la pantalla anterior sin iniciar sesión.
- Mensajes claros para credenciales incorrectas, usuario no configurado y cambio de contraseña inicial.

Si Cognito exige cambio de contraseña inicial, el mismo formulario presenta el campo de nueva contraseña y mantiene todo el flujo en español.

## Modales

Los modales contienen acciones cortas. Los formularios extensos utilizan una pantalla o panel dedicado.

## Drag and drop

Usar drag and drop solo donde aporte valor claro, especialmente en tareas por estado. Debe existir alternativa accesible por controles directos.

Para proyectos y tareas, drag and drop debe usarse en acciones que el usuario entienda visualmente:

- Arrastrar una tarea entre columnas de estado.
- Reordenar tareas dentro de una columna solo si aporta claridad.

Cada acción drag and drop dispone de una alternativa visible: botón `Agregar`, menú de responsable o selector de estado.

## Pantalla de proyectos y tareas

La pantalla principal debe permitir trabajar sin cambiar de contexto:

- Búsqueda principal por proyectos y tareas con alcance seleccionable: `Proyectos`, `Tareas` o ambos.
- Búsqueda independiente de personas dentro de la franja `Personas registradas`.
- Lista de proyectos como vista principal.
- Personas relacionadas dentro de cada tarjeta de proyecto.
- Descripción del proyecto visible bajo el título (cuando exista), en tipografía secundaria, para dar contexto sin abrir edición.
- Resumen de tareas por estado (conteos) dentro de cada proyecto.
- Kanban simple dentro del proyecto solo cuando el usuario presione `Ver tablero` (oculto por defecto).
- Panel de detalles para editar persona, proyecto o tarea sin salir de la pantalla.

Esta pantalla es la entrada operativa predeterminada cuando el usuario tiene acceso a proyectos o tareas. El orden de prioridad funcional determina el módulo inicial.

El panel de detalle permanece dentro de la misma pantalla y se abre mediante una acción explícita como `Editar`. En escritorio funciona como panel lateral derecho no modal, alineado con el proyecto o tarea; en móvil funciona como bottom sheet con scroll interno.

Cada tarjeta integra proyecto, responsable, personas y resumen de tareas en el primer nivel de lectura. En esta mesa, `persona` significa integrante operativo asignable a proyectos y tareas; `usuario` se reserva para cuentas de acceso, autenticación y administración.

La pantalla debe mostrar una franja compacta de `Personas registradas` para que el usuario pueda:

- Ver rápidamente quiénes existen.
- Arrastrar una persona a un proyecto para agregarla.
- Abrir edición con un ícono de lápiz y actualizar área, estado, notas o vacaciones/disponibilidad sin navegar a Administración.

La franja de personas muestra tarjetas compactas con nombre y acción de edición por ícono. Los datos secundarios viven en el panel de detalle y los estados vacíos se omiten.

La búsqueda principal filtra proyectos y tareas. `Buscar persona` filtra exclusivamente la franja de personas, mientras `Agregar persona` conserva las opciones disponibles para cada proyecto.

El listado de proyectos incluye filtros visibles por estado y comienza mostrando todos. Cada tarjeta presenta su estado actual en el primer nivel de lectura.

Por defecto, la tarjeta presenta el resumen de conteos por estado dentro del bloque `Tareas`. `Ver tablero` abre el Kanban completo del proyecto y `Ocultar tablero` restaura el resumen compacto.

Los estados utilizan color contextual sobrio: proyectos cerrados en rojo suave, activos en verde, planificados en azul y pausados en ámbar. Las tareas y prioridades usan badges o acentos equivalentes; los valores opcionales vacíos se omiten.

Las acciones de guardado en paneles de detalle deben mostrar retroalimentación visible dentro del mismo panel. Por ejemplo, al guardar proyecto o tarea debe mostrarse una confirmación como `Proyecto guardado correctamente.` o `Tarea guardada correctamente.`

La asignación de responsable utiliza la acción explícita `Asignar` o `Cambiar`, que abre la edición enfocada en el selector `Responsable`. Las instrucciones de arrastre aparecen únicamente cuando las personas disponibles están visibles.

Convención de verbos:

- `Crear`: inicia o confirma una alta rápida.
- `Editar`: abre un panel de edición contextual.
- `Guardar`: persiste cambios en un panel de edición.
- `Cancelar`: abandona una creación rápida sin guardar.

Los campos opcionales vacíos se omiten de la vista resumida. Por ejemplo, la cabecera presenta `Responsable` únicamente cuando existe una persona asignada.

La creación rápida debe pedir solo lo mínimo:

- Persona: nombre y apellido.
- Proyecto: nombre.
- Tarea: título.

Los campos adicionales se completan desde el detalle opcional después de la creación rápida.

## Kanban simple

Estados sugeridos:

- Pendiente.
- En progreso.
- En revision.
- Completada.

El Kanban inicial se concentra en columnas de estado, movimiento de tareas y acciones directas.

## Menú dinámico por permisos

El frontend consume los permisos calculados por el backend y los utiliza para construir menú, módulos y acciones visibles. Lambda aplica la autorización efectiva.
