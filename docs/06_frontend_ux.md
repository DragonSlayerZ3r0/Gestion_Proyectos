# Frontend y UX

> **Naturaleza de este documento:** describe el **diseño objetivo** (especificación de UX). Para el **estado realmente implementado** (p. ej. la pantalla Inicio hoy es un dashboard con pestañas Resumen/Facturación), ver [`docs/02_modulos_funcionales.md`](02_modulos_funcionales.md) y [`docs/15_estado_implementacion.md`](15_estado_implementacion.md). La estructura de código del frontend (shell + módulos) está en [`docs/18_servicios_y_runtime.md`](18_servicios_y_runtime.md).

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
- En pantallas operativas densas, el menú lateral debe poder contraerse para liberar espacio de trabajo.

## Menú lateral

El menú se construye desde la respuesta de `GET /api/me`. Solo debe mostrar módulos habilitados para el usuario.

Ocultar opciones no reemplaza seguridad backend.

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
- Evitar tablas con demasiada informacion por fila.

## Formularios

- Campos minimos necesarios.
- Validacion visible.
- Mensajes claros.
- Guardado evidente.
- En `Proyectos y tareas`, los formularios de registro de personas y creación de tareas deben estar colapsados por defecto y abrirse solo cuando el usuario presione `Registrar persona` o `Crear tarea`. Si el usuario abandona una creación rápida, la acción debe llamarse `Cancelar`, cerrar el formulario y limpiar sus campos.

## Login

La vista principal sin sesión debe ser una pantalla de acceso aislada y moderna. No debe mostrar menú lateral, módulos, tableros, paneles internos ni contenido operativo de la plataforma antes de autenticar al usuario.

La portada de acceso debe mostrar solamente:

- Marca de la plataforma.
- Mensaje breve de acceso interno.
- Ambiente actual.
- Acción principal `Ingresar`.

En pantallas anchas, los bloques de marca e ingreso deben mantenerse como una unidad centrada con ancho máximo. La tarjeta de ingreso no debe desplazarse al extremo derecho del viewport.

El login visible al usuario debe estar en español. La ventana de credenciales debe incluir:

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

- Arrastrar una tarea entre columnas de estado.
- Reordenar tareas dentro de una columna solo si aporta claridad.

Cada acción drag and drop debe tener una alternativa visible: botón `Agregar`, menú de responsable o selector de estado. El sistema no debe depender exclusivamente del arrastre.

## Pantalla de proyectos y tareas

La pantalla principal debe permitir trabajar sin cambiar de contexto:

- Búsqueda principal por proyectos y tareas con alcance seleccionable: `Proyectos`, `Tareas` o ambos.
- Búsqueda independiente de personas dentro de la franja `Personas registradas`.
- Lista de proyectos como vista principal.
- Personas relacionadas dentro de cada tarjeta de proyecto.
- Resumen de tareas por estado dentro de cada proyecto.
- Tareas principales visibles dentro de cada proyecto.
- Kanban simple dentro del proyecto solo cuando el usuario presione `Ver tablero`.
- Panel de detalles para editar persona, proyecto o tarea sin salir de la pantalla.

Esta pantalla debe ser la entrada operativa predeterminada cuando el usuario tenga acceso a proyectos o tareas. Evitar abrir Administración o Catálogo como primera vista solo por orden alfabético de permisos.

El panel de detalle debe permanecer dentro de la misma pantalla, sin tapar el tablero ni bloquear el trabajo del usuario. No debe abrirse automáticamente al seleccionar una tarjeta; debe abrirse solo con una acción explícita como `Editar`. En escritorio debe comportarse como panel lateral derecho no modal alineado con el proyecto o tarea que se está editando; en móvil debe comportarse como bottom sheet con scroll interno.

La pantalla no debe depender de seleccionar un proyecto arriba para ver tareas en una zona inferior. El usuario debe entender proyecto, responsable, personas y tareas sin hacer clic. En esta mesa, `persona` significa integrante operativo asignable a proyectos y tareas; `usuario` se reserva para cuentas de acceso, autenticación y administración.

La pantalla debe mostrar una franja compacta de `Personas registradas` para que el usuario pueda:

- Ver rápidamente quiénes existen.
- Arrastrar una persona a un proyecto para agregarla.
- Abrir edición con un ícono de lápiz y actualizar área, estado, notas o vacaciones/disponibilidad sin navegar a Administración.

La franja de personas no debe mostrar datos secundarios por defecto. Cada tarjeta debe ocupar poco espacio: nombre de la persona y acción de edición por ícono. Si una persona no tiene estado, no debe mostrarse badge ni texto de relleno.

La búsqueda principal no debe ocultar personas registradas ni impedir asignarlas a un proyecto. Las personas deben filtrarse únicamente desde `Buscar persona`, y el selector `Agregar persona` dentro de cada proyecto debe seguir mostrando las personas disponibles para ese proyecto.

El listado de proyectos debe incluir filtros visibles por estado. Por defecto se muestran todos los estados. Cada tarjeta de proyecto debe mostrar su estado actual para evitar que el usuario tenga que abrir el detalle para entenderlo.

Cuando el usuario abre `Ver tablero`, la tarjeta debe ocultar la lista resumida de tareas para evitar dos tableros visibles del mismo proyecto. El Kanban reemplaza la vista resumida hasta que el usuario presione `Ocultar tablero`.

Los estados deben tener color contextual sobrio: proyectos cerrados en rojo suave, activos en verde, planificados en azul y pausados en ámbar. Las tareas y prioridades también deben mostrarse con badges o acentos de color para facilitar lectura rápida. Si un proyecto no tiene estado o una tarea no tiene prioridad, no se debe mostrar un badge vacío ni texto de relleno.

Las acciones de guardado en paneles de detalle deben mostrar retroalimentación visible dentro del mismo panel. Por ejemplo, al guardar proyecto o tarea debe mostrarse una confirmación como `Proyecto guardado correctamente.` o `Tarea guardada correctamente.`

La asignación de responsable de una tarea debe hacerse con una acción explícita `Asignar` o `Cambiar`, abriendo la edición enfocada en el selector `Responsable`. No se debe mostrar texto que indique arrastrar personas si no existe un panel visible de personas disponibles para esa acción.

Convención de verbos:

- `Crear`: inicia o confirma una alta rápida.
- `Editar`: abre un panel de edición contextual.
- `Guardar`: persiste cambios en un panel de edición.
- `Cancelar`: abandona una creación rápida sin guardar.

Los campos opcionales no deben generar ruido visual cuando están vacíos. Por ejemplo, un proyecto sin responsable no debe mostrar `Responsable: Sin responsable` en su cabecera.

La creación rápida debe pedir solo lo mínimo:

- Persona: nombre y apellido.
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
