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

**Administración anclada abajo (2026-07-23):** la entrada de Administración NO va entre los módulos de trabajo — vive en su propio contenedor `#navBottom` anclado al fondo del sidebar, separada por un divisor y con ícono de engrane + etiqueta (patrón "configuración abajo" de VS Code/GitHub/Slack: la administración es configuración, no trabajo diario). El engrane es SVG inline (nítido y hereda el color; un emoji varía por plataforma) y siempre acompaña al texto — el resto del menú es de texto y un ícono solitario perdería descubribilidad. En móvil (≤ breakpoint) el sidebar es estático y Administración queda simplemente al final con su divisor. Si el usuario no tiene el módulo admin, el contenedor queda oculto.

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
- **Contexto temporal de HOY en la barra global (2026-07-29).** «¿En qué Q vamos?, ¿qué semana es?» son preguntas constantes al planificar, y la respuesta **no depende del módulo** → va en la barra superior, no dentro del encabezado de un módulo. Visible: `jue 30 jul · Q3 · sem 31` (fecha para ubicarse, trimestre porque es el lenguaje de la gerencia, semana **ISO** porque es la de Excel y los reportes). El resto —semestre, quincena, semana del mes, días hábiles que faltan— va en un **panel que se abre al pulsar el chip** (cierra al pulsar fuera o con `Escape`). **NO usar el `title` nativo para información que el usuario necesita**: tarda ~1 s en aparecer (el navegador controla ese retardo, no se puede acelerar) y en pantallas **táctiles no existe** — al tocar no pasa nada. El `title` sirve solo para aclaraciones prescindibles de un ícono ya etiquetado. Los días hábiles se cuentan **lunes a viernes y NO descuentan asuetos**: decisión del usuario (2026-07-29) de usar la fecha real del calendario sin acoplarse al catálogo de asuetos del módulo Personal; la etiqueta dice «(lun-vie)» para que el número no se malinterprete: está cuando se necesita y no ocupa espacio cuando no. En ≤720px se recorta a `Q3 · sem 31` (la fecha ya la da el teléfono). **Q = trimestre** (Q3 = tercer trimestre): usar UNA sola forma en toda la app. **Semana ISO ≠ semana del mes** — mezclarlas descuadra reportes. Todo se DERIVA de la fecha: no hay dato que capturar.
- **CREAR vs BUSCAR: separar por FORMA, no por color (regla 2026-07-29).** Dos trabajos distintos no pueden verse igual. Un campo de «crear» junto a uno de «buscar» son dos cajas de texto idénticas (peor apiladas en móvil) y el usuario no distingue dónde está cada cosa. **Crear es ocasional** → va detrás de un botón primario que abre el formulario (mismo patrón de «Registrar persona»/«Crear tarea»); **buscar es constante** → campo siempre visible, con **ícono de lupa** y su propio bloque separado por una línea. La diferencia queda en forma y peso, que se leen en escala de grises y no dependen de distinguir tonos (~8 % de los hombres tiene deficiencia de visión al color). **No usar color como separador**: el relleno de acento está reservado a la ÚNICA acción primaria de la pantalla; un segundo color competiría con ella. Corolario: al abrir el formulario, el botón que lo cerró pasa a **secundario** — «Cancelar» nunca puede pesar lo mismo que «Crear» (dos rellenos apilados se leen como dos acciones principales).
- **Efectos secundarios: van junto a la MUTACIÓN, no en el render (regla 2026-07-28).** En este frontend conviven el render completo (`renderWorkspace`) y **repintados parciales** (p. ej. `applyProjectSearch`, que existe para que el teclado móvil no se cierre). Colgar un efecto —persistir preferencias, avisar, sincronizar— del render completo **lo pierde en todas las rutas parciales**: pasó con la búsqueda persistida, que se guardaba en el render y por eso nunca se guardaba al teclear. Poner el efecto en la línea siguiente a la mutación del estado.
- **Carriles reservados en celdas de tabla (regla 2026-07-28):** cuando una celda lleva un ícono anclado a la derecha (p. ej. el clip de adjuntos en la columna Solicitud), el espacio se reserva con `padding-right` en la CELDA. **Cuidado con la especificidad**: `.projectTable td` (0,1,1) le gana a una clase suelta como `.projName` (0,1,0), así que el carril hay que declararlo como `.projectTable td.projName` — si no, el padding vuelve al de la tabla y los textos largos pasan por debajo del ícono (bug real). Con `table-layout: fixed` la elipsis corta en el borde de la caja de contenido, o sea ANTES del carril: el «…» y el ícono nunca se tocan. Todo texto que pueda recortarse debe llevar `title` con el valor completo para poder leerse al pasar el mouse.
- **Campo + botón en columnas ANGOSTAS (regla 2026-07-24):** la clase compartida `.inlineForm` maqueta en **dos columnas** (`minmax(0,1fr) auto`), lo cual funciona en zonas anchas pero en un panel de detalle deja el campo tan corto que el usuario no ve lo que escribió (caso real: el seguimiento por tarea). En columnas angostas hay que **apilar**: campo a todo el ancho arriba, acciones debajo con el botón anclado a la derecha (`margin-right:auto` en la pista para que el botón no salte a la izquierda al envolver). **Si el formulario conserva la clase `.inlineForm`, la regla propia DEBE resetear `grid-template-columns: 1fr`** — sin esa línea el apilado no ocurre aunque se declare `display:grid`. Cuando el texto puede pasar de un renglón, usar `<textarea>` con auto-crecimiento (JS ajusta el alto al contenido con un tope) y conservar el gesto: **Enter envía, Shift+Enter salta de línea**; tras enviar hay que devolver el alto a su base.

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

## Estándares visuales y de usabilidad (aplicados en Solicitudes 2026-07-04; OBLIGATORIOS para módulos nuevos y rediseños)

Basados en heurísticas establecidas (jerarquía visual, divulgación progresiva, ley de Hick) y en que **parte de los usuarios no ha usado herramientas tipo Trello/Asana** — pero todos conocen Excel. Referencias: patrón maestro-detalle, listas vs tarjetas (Eleken/Stan Vision), empty states y onboarding (uiFromMars/EspacioUX/UserGuiding). Versión visual navegable: `docs/Guia 05 - Estandares visuales y UX.canvas` (Obsidian).

1. **El objeto principal primero.** Al abrir un módulo, lo primero visible es aquello a lo que el usuario vino (la lista de solicitudes, no formularios ni funciones administrativas). Nada esencial bajo el pliegue.
2. **Maestro-detalle con tabla compacta.** Para colecciones homogéneas: tabla escaneable (patrón familiar tipo hoja de cálculo) → clic abre el detalle de UN elemento a la vez. No usar tarjetas grandes repetidas como listado (impiden escanear). Columnas: lo que responde "¿cuál es cuál?" y "¿qué se movió?" (estado, responsable, conteos, última actividad).
   - **Tablas con volumen → configurables, recordando la preferencia.** Cuando una tabla puede crecer o tener muchas columnas: chips para el filtro más común (1 clic, p. ej. Estado), **mostrar/ocultar y REORDENAR columnas** (menú "Columnas": casilla + flechas ↑/↓ por columna, 2026-07-08; el identificador siempre visible y siempre primero — no se reordena; una columna puede nacer oculta con `defaultHidden`, p. ej. "Grupo de trabajo") y **anchos arrastrables** (`table-layout: fixed` + `<colgroup>`; texto recortado con elipsis + tooltip, ensanchar revela más). Columnas y anchos se **persisten por navegador** (localStorage), no en backend. El clic en encabezado ordena; el asa de ancho no. Es consistente con lo que un usuario de Excel espera. Referencia: tabla de Solicitudes en `workspace.ts` (`PROJECT_COLUMNS`, `renderProjectCell`, `data-col-resize`).
   - **Muchas dimensiones de filtro → popover "Filtros" + chips removibles (2026-07-07).** Con 4+ dropdowns la barra se satura y no escala. Patrón (Linear/GitHub): un botón **`Filtros ▾` con badge** del número de dimensiones activas abre un popover con TODAS las dimensiones apiladas (mismo cascarón que "Columnas", cierre al clic fuera); cada filtro activo se muestra en la barra como **chip removible** (`Solicita: Riesgos ✕`) — lo activo queda siempre visible y reversible (evita el "filtro invisible" que hace confundir el conteo, ya pasó con el buscador). Los filtros son AND entre sí (p. ej. Área solicitante = X **y** Grupo de trabajo = Y a la vez). "Limpiar" resetea todo. Referencia: `renderFiltersControl`/`renderActiveFilterChips` en `workspace.ts`.
   - **Cuando el detalle se apila DEBAJO del maestro** (misma columna), el clic puede parecer "no hacer nada" si el panel queda fuera de pantalla — pero la solución NUNCA es saltar de lleno al detalle (anti *scroll hijacking*: un clic de selección no debe quitarle al usuario su contexto; quizá solo quería seleccionar). Obligatorio el trío de señales: (a) *affordance* en cada fila — chevron "›" al final que en la fila seleccionada gira a "▾" apuntando al detalle; (b) **revelado parcial ("peek")** al seleccionar: desplazamiento mínimo para que ~180 px del panel asomen por abajo, con el listado aún a la vista; el viaje completo al detalle solo con intención explícita (clic en el chevron); todo suave y respetando `prefers-reduced-motion`; (c) **destello breve** del borde del panel (WAAPI, ~900 ms) para dirigir la mirada. El panel además se auto-titula ("Detalle de la solicitud"), no asume que el usuario sabe qué es. Implementación de referencia: `revealProjectDetail(full)` en `workspace.ts` + `.projChevron` en `app.css`.
3. **Una sola acción primaria por pantalla** (botón lleno con el color de acento). Todo lo secundario en neutro/suave — si varias cosas gritan en verde, ninguna es la principal.
4. **Disciplina de color**: acento solo donde significa algo; rojo RESERVADO a peligro/error; estados siempre con los mismos colores en toda la app Y con texto (nunca solo color — daltonismo); contraste legible (≥4.5:1).
   - **Para distinguir SECCIONES, la pista es la FORMA, no el color (2026-07-31).** Varios bloques con el mismo marco y el mismo título obligan a LEER cada etiqueta para encontrar la que se busca. Solución: un **ícono de trazo por sección** en su encabezado (helper `blockHeaderHtml` en `workspace.ts`) + el título un punto más fuerte que el texto interno. Nada de un color de fondo por bloque: aquí el color ya significa estado o acción principal, y además no ayuda a quien tiene deficiencia de visión al color; la forma funciona en escala de grises y para todos. **La otra mitad del problema es el ritmo vertical**: si la separación ENTRE secciones es parecida a la de adentro (eran 16 vs 10), se leen como una sola masa — dejar el doble afuera que adentro (20 vs 10) y cuidar que ningún margen propio se sume al gap y descuadre una sola sección.
5. **Acciones visibles con texto para todo lo esencial.** Drag & drop, doble-clic o gestos solo como ATAJO, nunca como único camino (los novatos no los descubren); si existe un atajo, un hint en texto lo cuenta.
   - **Si el efecto del control cae FUERA de la pantalla, llevar la vista es parte de la acción (2026-07-31).** Un botón cuyo formulario o panel se dibuja lejos —otra sección, más abajo del pliegue— se siente ROTO: el usuario pulsa, no ve nada y concluye que no funciona (pasó con «+ Entregable», que vive en el bloque Tareas y abre su formulario arriba del tablero; el usuario reportó dos veces "no pasa nada" / "no encuentro ese botón"). Obligatorio en ese caso: `scrollIntoView({block:"center"})` al panel, `focus({preventScroll:true})` al primer campo (para no pelear con el desplazamiento) y **destello breve** del panel — misma convención del estándar #2, respetando `prefers-reduced-motion`. Y al revisar una función OPCIONAL, probar SIEMPRE primero el estado de **cero elementos**: es el único que ven todos y el que contiene el camino de entrada.
   - **Icono vs. texto (convención de la app, obligatoria y consistente):** **editar → ícono de lápiz**; **borrar → ícono de papelera (rojo) + confirmación**; **crear / acción primaria → botón con texto visible**. Los iconos de editar/borrar SIEMPRE llevan `title` y `aria-label` (tooltip) — así son compactos sin volverse un gesto oculto (no violan esta regla porque son affordances etiquetadas, no escondidas). Evitar botones-palabra largos ("Corregir nombre del área", "Eliminar") para acciones que ya tienen su ícono: hacen ruido y rompen la consistencia con el resto de la app (personas, tareas, seguimiento usan el lápiz). Helpers de referencia: `renderEditIconButton` / `renderDeleteIconButton` en `app.ts`.
   - **Tercer matiz (2026-07-28): en TARJETAS densas, las acciones recurrentes también van con ícono.** El responsable de una tarea tenía un botón con texto ("Asignar"/"Cambiar") que competía con el título y el chip en una tarjeta que ya carga prioridad, fechas, avance y conteo de seguimientos. Pasa a **ícono de persona** (`persona+` para asignar, `persona` para cambiar — el chip contiguo ya dice quién es), con `title` + `aria-label`. Variante `.iconTinyButton--onCard`: 26px, **sin marco ni fondo en reposo** y con acento solo al apuntar/enfocar — junto a un chip, una caja más vuelve a amontonar. No sobrescribir el borde del hover: lo fija la regla global `button:hover:not(:disabled)` (0,2,1) y así el gesto se siente igual en toda la app.
   - **Matiz (2026-07-07): el borrado de ítems de CATÁLOGO va DENTRO del flujo de edición, no como papelera siempre visible.** Una papelera roja permanente junto a un selector hace ruido (el rojo llama la atención sin que haya intención de borrar, y borrar un ítem de catálogo es rarísimo). Patrón: lápiz → se abre el mini-formulario de edición → ahí vive "Eliminar X" (botón `tinyButton danger`, con confirmación; el backend protege si está en uso). La papelera visible queda para borrar ÍTEMS DE FILA donde borrar es parte del trabajo diario (p. ej. entradas de seguimiento vía su formulario de edición, tareas). Aplicado en los catálogos de área y estado (`workspace.ts`). **Segundo matiz (2026-07-08):** cuando una papelera de fila es de uso RARO y queda adyacente a un control frecuente (p. ej. adjuntos junto al selector "Relacionar con"), va **neutra por defecto y roja solo al hover** + confirmación **específica con el nombre** de lo que se borra — el rojo permanente es ruido y los confirms genéricos se aceptan por hábito.
6. **Funciones administrativas/ocasionales degradadas**: colapsadas o secundarias (p. ej. "Personas registradas"), auto-expandidas solo si hay una acción en curso ahí.
7. **Filtros, contadores y ACCIONES pegados a lo que afectan**, no en otra zona de la pantalla. Vale para los controles igual que para los filtros: «Crear tarea» y «Ver tablero» vivían en el encabezado de la solicitud, revueltos con «Editar solicitud» y a media pantalla de las tareas — se movieron a la tarjeta **Tareas** junto con «+ Entregable» y el campo «Nueva tarea» (2026-07-31, propuesto por el usuario). Criterio: el **encabezado** solo lleva acciones sobre la entidad completa; cada bloque lleva las suyas. Mover el control junto a su efecto es mejor que compensar la distancia con un `scrollIntoView` (ver el matiz del estándar #5).
   - **Fila de chips multi-selección = juego de CASILLAS; la forma manda sobre la conducta (2026-07-30).** Si N chips se ven encendidos, el control PARECE N casillas: entonces un clic debe **alternar solo ese chip**, siempre, sin excepciones. El primer diseño hacía que el primer clic **aislara** (apagaba los otros siete): se comportaba como botones de radio con aspecto de casillas, y **quitar un solo estado costaba 7 clics** — justo lo más frecuente en una bandeja larga ("todo menos Cerrado"). La disonancia forma/conducta no se arregla con tooltips. Patrón obligatorio: (a) chips = alternar, encendido = incluido; (b) **un chip líder que es ACCIÓN, no valor** — rotula lo que hará (**«Ninguno»** cuando están todos, **«Todos»** cuando falta alguno), se dibuja distinto (sin relleno, borde punteado) y le reserva **ancho fijo** para que la fila no se corra al cambiar de etiqueta; (c) aislar = 2 clics (Ninguno → el que quiero), el costo estándar de Excel/Jira/Linear; (d) con cero marcados, la lista **no puede volver a mostrarlo todo por su cuenta** (haría que el clic no tuviera efecto visible): dice «Ningún estado seleccionado» + botón «Ver todos».
     **Nunca resolver esto con doble clic ni gestos ocultos**: es invisible (nadie lo descubre solo — Norman & Nielsen: lo que no está en un menú no se descubre explorando), **no existe al tocar** (el doble tap es zoom), excluye a quien tiene poca motricidad fina (WCAG 2.5.1 pide alternativa de un solo punto), y sobre un interruptor **un doble clic son dos alternancias que se cancelan**: obligaría a retrasar cada clic ~250 ms o a repintar en falso. Referencia: `renderProjectStatusFilters`/`selectedStatusIds` en `workspace.ts` y `.filterChip--action` en `01-base.css`.
8. **Empty states que guían**: qué es esto + qué hacer + botón que lo hace ("Crear la primera solicitud" enfocando el formulario). Nunca un texto suelto.
9. **Vocabulario del usuario, consistente**: si el producto dice "solicitud", TODOS los textos (botones, confirmaciones, hints, errores) dicen solicitud; sin jerga técnica visible.
10. **Prevenir el error antes que corregirlo**: validaciones con mensaje accionable (p. ej. duplicado de persona → "agrega el segundo apellido o el área"), validadas en backend.
12. **Formulario de detalle = panel de propiedades (inspector) compacto, no formulario de aterrizaje.** Los editores de detalle (panel derecho de una solicitud, persona, tarea) deben ser densos: **etiquetas pequeñas y tenues** (~0.74rem, peso 600, color `--muted`) que guían sin competir con el valor; inputs densos (`min-height` ~34px, padding ~6-9px); ritmo vertical ajustado (gap ~9px). Las **acciones de un campo** (p. ej. corregir/eliminar un ítem de catálogo) van **inline a la derecha del control** (`.fieldWithActions`), nunca flotando en su propia línea. Campos cortos afines pueden ir **dos por fila** (`.detailRow2` con `minmax(0,1fr)`). Para **fechas**, usar `<input type="date">` (calendario nativo + escritura manual; muestra dd/mm/aaaa según locale) — no librerías. **Pares de fechas (2026-07-09):** en rangos Desde/Hasta (ausencias de Personal, Solicitud/Entrega), la fecha inicial MANDA — al elegirla, la final se precarga con ese valor (su calendario abre AHÍ, no en hoy) y recibe `min` para impedir anteriores. Y el **popup del calendario nativo no es posicionable por CSS** (el navegador decide arriba/abajo según espacio): si el formulario puede quedar al borde inferior, hacer `scrollIntoView({block:"center"})` al abrirlo para que siempre haya espacio debajo (aplicado en Personal). Referencia: `renderProjectDetail` en `workspace.ts` + `.detailForm`/`.fieldWithActions` en `01-base.css`.
13. **Un solo punto de entrada por tipo de contenido (2026-07-07).** Si un contenido puede "pertenecer" a varios contextos (p. ej. un adjunto: general o de una entrada de seguimiento), NO poner un botón de alta en cada contexto — dos puntos de subida generan la duda "¿dónde lo pongo?". Un solo lugar de alta (la franja Adjuntos) y el contexto se asigna como **propiedad del elemento** (selector "Relacionar con", opcional con default sensato, editable después, con vista previa del texto para elegir con contexto y un "+ Nueva nota…" que crea el contexto al vuelo). En los demás contextos el contenido aparece como vista (chips clicables), no como otro punto de gestión. Referencia: adjuntos en `workspace.ts` (`renderProjectAttachments`, `renderAttachRelate`).
14. **Modo inmersivo / pantalla completa (2026-07-31).** Para lienzos y vistas de presentar (Pizarra, línea de tiempo) donde el andamiaje de la app le quita espacio al contenido. Reglas: (a) **el layout NO puede depender de la Fullscreen API** — en iPhone no aplica a elementos que no sean `<video>`, así que el modo se logra con una clase en el shell (ocultar menú y encabezado, panel a `100dvh`) y la pantalla completa real se pide **encima, como mejora**, con `?.()` y `.catch()`; si el navegador la rechaza, el usuario igual gana el espacio y el botón nunca se siente muerto (verificado con la petición rechazada a propósito). (b) **La clase va en el contenedor estable** (`#app`), no en el panel que se repinta: si cuelga de algo que se vuelve a dibujar, cualquier acción que repinte saca del modo. (c) **Tres salidas**: el mismo botón —que adentro lleva TEXTO, porque sin barras del navegador la salida tiene que ser evidente—, `Escape`, y salir solo al abandonar la vista (quedarse inmersivo sobre otra pantalla deja al usuario sin menú). Escuchar `fullscreenchange` para devolver el layout si el usuario sale por su cuenta (Esc/F11). (d) Si el contenido dibuja en canvas, **comprobar** si necesita aviso de cambio de tamaño: los que usan `ResizeObserver` (Excalidraw 0.17.6 entre ellos) se corrigen solos en un cuadro — el desfase que parecía permanente era del instrumento de medición, ver el límite del panel de vista previa en el criterio 8 y `docs/22_bitacora.md` (2026-07-31). Para los que no observan su contenedor, el aviso es `window.dispatchEvent(new Event("resize"))` en la siguiente macrotarea (no en `requestAnimationFrame`). (e) En móvil, revisar que la barra de acciones no se coma lo ganado. Referencia: `setImmersive`/`syncImmersiveButton` en `draw.ts` + `.shell.drawImmersive` en `08-draw.css`.
15. **Un panel accesorio NUNCA repinta al contenedor que aloja estado vivo (2026-07-31).** El patrón general de la app —repintar con `innerHTML` y revincular listeners— es inofensivo con DOM sin estado, y deja de serlo cuando ese contenedor aloja algo que guarda **estado propio en memoria**: un editor montado (Excalidraw/React), un `<canvas>`, un archivo a medio subir, un socket abierto. Repintar el padre para mostrar u ocultar un panel accesorio **destruye ese estado** y lo rehidrata desde el servidor, o sea borra lo que todavía no se había guardado. Regla: cada zona que se muestra/oculta vive en **su propio contenedor** y se pinta sola (`#drawShareHost` en Pizarra, con `:empty { display: none }` para no dejar el `gap` fantasma); si repintar el padre fuera inevitable, primero **persistir y esperar**. Y si desmontar destruye trabajo (salir del editor), se guarda ANTES de desmontar y, cuando el guardado falla, se pregunta en vez de perderlo en silencio. Síntoma de que se violó la regla: el trabajo "se deshace solo" al tocar un control que no tenía nada que ver con él. Es la otra cara de la regla 14(b): aquella protege el modo inmersivo del repintado, esta elimina el repintado. **Contrapartida obligatoria:** si el panel le quita alto a un lienzo, hay que **avisarle del cambio de tamaño** — Excalidraw no observa su contenedor, se remide con el `resize` de la ventana (regla 14(d)), y el aviso NO puede ir en un `requestAnimationFrame`: ahí el layout nuevo todavía no está aplicado y remide el alto viejo; va en la siguiente macrotarea (`setTimeout 0`). Sin esto el lienzo se desborda invisible y el puntero queda desfasado de lo que se ve. Referencia: `notifyCanvasResize` en `draw.ts`.
11. **El guardado cuenta su historia (velocidad real + percibida).** Al hacer clic en Guardar, el botón pasa INMEDIATAMENTE a "Guardando…" deshabilitado (confirma que el clic entró y evita el doble-submit) y al confirmar se muestra "✓ Guardado" junto al botón — nunca dejar al usuario adivinando si debe volver a presionar. En lo real: tras un PATCH se **fusiona la respuesta en el estado local y se repinta** (`mergeProject`/`mergePerson`… en `workspace.ts`), NO se recarga la colección completa; y los endpoints de carga evitan el patrón N+1 (consultas por hijo y por elemento) usando lecturas globales por tipo vía el GSI `byEntityType` agrupadas en memoria. Si una recarga completa es inevitable, se hace manteniendo lo pintado (nunca pasar por una pantalla "Cargando" intermedia). UI optimista (aplicar antes de confirmar) solo si esto no alcanza.

## Estructura del CSS (estándar de estilos)

Los estilos viven en `frontend/src/styles/`, **partidos por módulo con prefijo numérico** e importados EN ORDEN en `index.astro` (la cascada depende del orden): `01-base.css` (tokens `:root` + reset + tipografía + botones/paneles + shell + login + base de workspace), `02-catalog`, `03-admin`, `04-home`, `05-chat`, `06-responsive-misc`, `07-workspace`, `08-draw`, `09-staff`. Nota: `01-base` sigue siendo el mayor porque la base no estaba limpiamente seccionada; los módulos tardíos sí quedaron aislados.

**Trampa al REUSAR una clase base de layout en un contenedor nuevo (2 bugs reales 2026-07-08).** Antes de poner una clase compartida (`.searchInput`, `.inlineForm`, chips…) en un contenedor distinto al original, revisar qué asume esa clase sobre su padre — el mismo valor cambia de significado según el contexto: (1) `.searchInput` trae `flex: 1 1 320px`, pensado para una barra en **fila** donde `320px` = ancho; en un contenedor `flex-direction: column` ese 320px pasa a ser **altura** → input gigante (pasó con el buscador de Personal; fix: `flex: none` + `max-width`). (2) `.inlineForm` es **`display: grid`** de 2 columnas, NO flex; ponerle `flex-direction: column` no hace nada → los campos caen lado a lado (pasó con el form de query de adjuntos; fix: `display: flex` explícito). Regla: si el layout depende de flex/columna, **declara `display` y el eje explícitamente** en tu clase, no confíes en heredarlo. Este tipo de bug compila y pasa `npm run check` — solo se ve en pantalla.

**Trampa al ocultar un ítem de un GRID con `display: none` (bug real 2026-07-31).** Al ocultar el menú lateral para el modo inmersivo de Pizarra, `.main` —segundo ítem de `.shell` (`grid-template-columns: 276px 1fr`)— **cayó a la columna 1**: `display: none` saca al elemento del flujo del grid y los demás se recorren. Poner la primera columna en `0` no salva nada: el contenido quedó de 20px de ancho (y solo se vio midiendo el **ancho**, porque el alto sí daba bien). Salida usada por `.loginOnly`, `.booting` y `.drawImmersive`: **cambiar el shell a `display: block`** cuando el menú desaparece. Regla: al ocultar un ítem de un grid con columnas fijas, ajusta el layout del CONTENEDOR (o coloca al ítem restante con `grid-column`), nunca solo el ancho de la columna vacía. Y al verificar, medir **las dos dimensiones**.

**Color = tokens.** Toda decisión de color es un token en el `:root` de `01-base.css` (`--accent`, `--panel`, `--on-accent` [texto/íconos sobre color], `--danger`/`--danger-soft`/`--danger-border`, `--warn-soft`/`--warn-border` [ámbar de atención: tareas en revisión, permisos de Personal, chip de privilegio en Admin], `--surface-muted`, `--text-soft`, `--line`/`--line-strong`, `--muted`…). Regla: **no hardcodear un hex que ya sea un token** — el guardrail `npm run check:css` (`scripts/check-css-tokens.sh`) falla si un valor tokenizado aparece fuera de `:root`. Un color de un solo uso puede ser hex literal; si se repite y representa una decisión de diseño, conviértelo en token. Esto mantiene una sola fuente de verdad del color (y habilita un futuro modo oscuro).

## Responsive (teléfonos y tablets)

La app debe verse y usarse bien en escritorio, tablet y teléfono. `index.astro` ya trae el `<meta name="viewport">` correcto; los breakpoints viven en los archivos de `frontend/src/styles/` (el transversal en `06-responsive-misc.css`, y overrides por módulo dentro de su archivo) y siguen esta estrategia por capas:

| Breakpoint | Qué colapsa |
| --- | --- |
| `≤900px` | Catálogo: el layout de 3 columnas (sidebar/lista/detalle) pasa a 1 columna apilada; se ocultan minimapa e inspector del grafo. |
| `≤860px` | Inicio: los gráficos (tareas/proyectos) pasan a 1 columna. |
| `≤780px` | **Breakpoint principal**: el shell (sidebar+main) pasa a 1 columna (sidebar arriba, nav en 2 columnas), `contentGrid`/workspace/proyectos a 1 columna, el panel de detalle se vuelve *bottom sheet* fijo, formularios inline apilan el botón, Kanban a 1 columna. |
| `≤720px` | Chat: el sidebar de conversaciones pasa arriba (compacto) y el chat usa todo el ancho. |

**Bloque transversal (`≤780px`, al final de app.css):** cubre lo que los layouts por módulo no resuelven —
- **Tablas anchas** (`homeSvcTable`, `homeDailyTable`, incluida la highlight table de Athena): `display:block; overflow-x:auto` → cada tabla se desplaza de lado dentro de su propio contenedor sin romper la página.
- **Pestañas de Inicio** (hasta 5 con Facturación/Athena): scroll lateral en la fila de pestañas.
- Metadatos de tarjetas de consultas Athena en columna; panel ⓘ a ancho completo; filas de seguimiento de proyectos con wrap.

**Reglas al construir UI nueva:**
1. Nada de anchos fijos en px para contenedores de contenido; usar grids con `minmax(0, 1fr)` y `flex-wrap`.
2. Toda **tabla** nueva debe poder desplazarse horizontalmente en pantallas chicas (agregarla al bloque transversal o envolverla en un contenedor con `overflow-x:auto`). Si la tabla usa `table-layout: fixed` (columnas de ancho fijo/arrastrables), puede ser **más ancha que la pantalla** → su contenedor de scroll y **todos los ancestros flex/grid entre él y el viewport deben llevar `min-width: 0`**; si no, el item de grid/flex se expande al contenido y empuja la página de lado en móvil (bug real corregido en la tabla de Solicitudes: faltaba `min-width:0` en `.projectTablePanel`).
   - Regla de orden CSS: los overrides responsive de una sección deben ir en un `@media` que aparezca **después** de las reglas base de esa sección en el archivo; si el `@media` va antes, la base (misma especificidad, más tarde en el archivo) las gana y el responsive no aplica.
3. Toda fila de **controles** (filtros, selects, botones) debe llevar `flex-wrap: wrap`.
4. En elementos con scroll interno propio (SQL, listas largas), preferir `max-height` + `overflow:auto` para que el scroll de la página no se rompa en táctil.
5. Alturas de pantalla con `100dvh` (no solo `100vh`) donde el input inferior importe (chat), para que la barra del navegador móvil no lo tape.
6. **Buscadores que filtran EN VIVO: nunca re-renderizar el módulo entero en cada tecla.** Reconstruir con `innerHTML` destruye el `<input>` enfocado; re-enfocar el input nuevo (aunque sea en `requestAnimationFrame`) NO reabre el teclado en móvil (iOS/Android solo lo abren si el foco ocurre en un gesto del usuario y el elemento no se destruyó). Síntoma: **el teclado se cierra en cada letra**. Regla: el `input` de búsqueda debe **sobrevivir** al filtrado — re-renderizar SOLO el contenedor de resultados + el contador y re-enlazar sus handlers *acotados a ese contenedor* (así no se duplican listeners), dejando el input intacto. Precedentes: `applyProjectSearch`/`bindProjectListHandlers` en `workspace.ts`, `applySearch` en `catalog.ts`, `applyServiceFilter` en `home.ts`, `applyAthenaUserFilter`. (Bug real 2026-07-15: el buscador de Solicitudes cerraba el teclado en móvil por llamar `renderWorkspace()` en cada `input`.)
7. **Keyword = búsqueda en vivo; semántica = por envío explícito.** Una búsqueda **keyword** (substring) filtra bien tecla por tecla: cada letra **acota** el resultado, así que buscar en vivo es lo correcto. Una búsqueda **semántica** (embeddings) se escribe como una **frase/idea completa**; dispararla en cada tecla busca con frases a medias → resultados que saltan y confunden (además de una llamada al modelo por tecla). Regla: la búsqueda semántica se ejecuta **al enviar** (Enter o un botón «Buscar» visible), no en `input`. En móvil, el input `type="search"` ya muestra el botón "Buscar/Ir" del teclado (cae en el mismo `Enter`). Precedente: el toggle `≈ Avanzada` del Catálogo (2026-07-15, ajustado tras feedback del usuario: la versión con debounce en vivo confundía).
8. **Verificar el responsive es OBLIGATORIO y parte de "terminado"** (no un extra opcional): cada UI nueva o modificada se prueba al menos en 3 anchos — ~1280 (escritorio), ~768 (tablet) y ~390 (teléfono) — ANTES de darla por terminada. Preferir verificación real (servidor de preview `.claude/launch.json`, resize a 390) sobre solo razonar el CSS. Es un requisito permanente del usuario, no una recomendación.
   - **Límite del panel de vista previa (2026-07-31):** sirve para ver el layout (DOM, CSS, capturas), **no para medir cómo REACCIONA la UI a un cambio de tamaño**. El panel solo pinta cuando se le pide una captura, y sin pasos de renderizado el navegador no entrega `resize`, `ResizeObserver` ni `requestAnimationFrame` (los `setTimeout` sí corren, así que el engaño no se nota); además el resize del panel es emulación por CDP, que **no dispara ningún `resize`**. Consecuencia: un lienzo/observador se ve "roto para siempre" cuando en realidad se corrige solo en un cuadro. Para ese tipo de medición, Chrome headless (`--headless=new`) manejado por CDP, con la página dentro de un **iframe** al que el padre le cambia el tamaño. Detalle y números en `docs/22_bitacora.md` (2026-07-31).


## Animaciones (estándar)

Sin librerías de animación (se evaluó anime.js y se descartó: el render por `innerHTML` + repintados por sondeo destruirían/re-dispararían sus animaciones, y el producto es sobrio por diseño). El estándar nativo:

- **Micro-transiciones CSS** para estados (hover, colapso del sidebar con `cubic-bezier(0.22, 1, 0.36, 1)` ~260 ms, giro del ícono hamburguesa, fade+slide de las etiquetas del nav al expandir).
- **Web Animations API** (`elemento.animate(...)`) para la **entrada de vistas** al cambiar de módulo o pestaña (`animateViewEnter` en `app.ts`): no usa clases (los renders resetean `className`), corre en el compositor y **solo se dispara en navegación explícita** — nunca en los repintados de sondeos (Athena/chat/Data Lake), que re-renderizan sin animar.
- **`prefers-reduced-motion` se respeta siempre** (las animaciones de entrada se omiten si el usuario lo pide al sistema).
- Duraciones 150-260 ms; nada de coreografías largas en una herramienta de uso diario.
