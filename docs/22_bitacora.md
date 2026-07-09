# 22 · Bitácora del proyecto

Registro **append-only** de decisiones no obvias, incidentes y cambios de rumbo — la dimensión temporal que los demás docs no capturan (ellos describen el presente; aquí queda el **por qué y el cuándo**). Cualquier agente que retome el proyecto debe leer AGENTS.md y luego esta bitácora.

**Reglas del formato:**
- Una entrada por evento, la más reciente **arriba**. Nunca se edita ni borra una entrada pasada (si algo quedó obsoleto, se agrega una entrada nueva que lo diga y enlace a la anterior).
- Formato: `## AAAA-MM-DD · tipo — título`. Tipos: `decisión` · `incidente` · `cambio-de-rumbo` · `estándar`.
- 3–5 líneas: qué pasó / qué se decidió, por qué (alternativas descartadas si las hubo) y enlace a los docs afectados.
- La escribe quien hace el cambio (humano o agente), como último paso del flujo de sincronización (docs → AGENTS.md → bitácora).

---

## 2026-07-09 · estándar — Catálogos de valores: fuente única de punta a punta (auditoría DRY)

Detonante: agregar el tipo "Requerimiento" exigió tocar 3 `<select>` escritos a mano (crear/filtro/detalle) además del backend. El usuario pidió auditar TODO el proyecto y parametrizar cada conjunto de valores en un solo lugar. Resultado: el backend define catálogos `{key, label}` (`REQUEST_TYPES_CATALOG`, `TASK_STATUSES_CATALOG`, `TASK_PRIORITIES_CATALOG`, `PERSON_STATUSES_CATALOG` en `services/workspace.py`; `ABSENCE_TYPES` ya viajaba en `get_staff`) y los publica en el payload; las listas de claves para validación se DERIVAN. El frontend recorre el catálogo en todos los selects/filtros/chips/etiquetas (fallback local mínimo para el instante de un deploy cruzado): `requestTypes()`/`requestTypeLabel` en workspace, `priorityLabel` del shell lee el payload, estado de persona del payload, `absenceTypes()` en staff, `ROLE_OPTIONS` única en admin. Ya cumplían el patrón: manifest.py, PROJECT_COLUMNS, costAccounts, catálogos vivos AREA/PROJECT_STATUS. Regla nueva en AGENTS.md. Pendientes de DRY de CÓDIGO (no valores) anotados: helpers de fecha y normalizeSearch duplicados entre módulos.

## 2026-07-08 · decisión — Invitaciones de Pizarra visibles sin refrescar (refresh + sondeo de lista)

El invitado no veía la invitación: la lista de Pizarra se cargaba UNA vez por sesión y quedaba cacheada (ni salir/entrar al módulo la refrescaba). Fix en dos partes: (1) la lista se refresca en CADA entrada al módulo y al volver del editor (silencioso: pinta lo que hay y repinta al llegar lo fresco, sin "Cargando"); (2) sondeo cada ~10 s mientras el usuario está parado en la lista (solo módulo activo + vista lista + pestaña visible; repinta solo si algo cambió, preservando lo tecleado en "Nueva pizarra"). Costo analizado con el usuario: centavos/mes (una llamada a Cost Explorer cuesta más que un día de sondeos). Alternativa anotada para escala: push real por el WebSocket (canal personal) — más código, vale si crecen los usuarios o se quiere campanita global. OJO: el selector "Compartir con" lista usuarios SIN el módulo Pizarra asignado — esos nunca verán la invitación (mejora pendiente: marcarlos). Ver `docs/02`.

## 2026-07-08 · decisión — Orden de columnas por usuario en la tabla de Solicitudes

Cada usuario ordena las columnas a su gusto: menú `Columnas ▾` con flechas ↑/↓ por fila (además de mostrar/ocultar), persistido por navegador en el mismo localStorage que visibilidad/anchos (`gp.projectTable.v1`, clave `order`). "Solicitud" (identificador del maestro-detalle) siempre visible y SIEMPRE primera — sin flechas. Claves desconocidas guardadas se ignoran; columnas nuevas del código caen al final. Se eligió flechas en el menú y NO arrastrar encabezados: el arrastre del encabezado ya es el ajuste de ancho (mezclar gestos en la misma zona = errores de manipulación) y la regla de la app es gesto-como-atajo, nunca único camino. Ver `docs/06` estándar 2.

## 2026-07-08 · estándar — Metadatos tenues y señales ancladas (lote de jerarquía visual)

Tres refinamientos con el mismo principio (el usuario los fue señalando): (1) en "Última actividad" la fecha pasó a formato corto y tenue (`6 jul`, año solo si difiere; antes negrita+acento+formato largo — el metadato desplazaba al texto del seguimiento y usaba acento decorativo); (2) el clip de adjuntos va ANCLADO al borde derecho de la celda Solicitud (pegado al texto se perdía con nombres que envuelven; antes del título rompería la alineación izquierda del identificador — fijo forma un riel vertical escaneable, patrón correo); (3) la ficha de Personal es ACORDEÓN bajo la fila seleccionada con `scrollIntoView block:nearest` (al final del panel quedaba lejísimos del clic en listados grandes). Además: chips de acceso en Administración (color SOLO en privilegio: rol admin=acento, módulo Administración=ámbar) con familia de tokens nueva `--warn-soft`/`--warn-border`, y nota por persona `staffNotes` exclusiva de Personal. Ver `docs/06`, `docs/08`, `docs/09`, `docs/02`.

## 2026-07-08 · decisión — Colaboración en vivo de Pizarra: WebSocket serverless en la propia cuenta

El usuario aclaró que "compartir" debía ser como el Live collaboration de excalidraw.com: varios editando el MISMO tablero a la vez. El componente embebido no trae eso (la colaboración nativa vive en los servidores de excalidraw.com — descartado: datos del banco a terceros + dominio bloqueado en laptops corporativas). Alternativas evaluadas con el usuario: servidor dedicado excalidraw-room en contenedor (descartado: costo fijo siempre encendido) y sync por sondeo (descartado: no es simultáneo real). **Elegido: API Gateway WebSocket serverless** — cada tablero es una sala; la MISMA Lambda ramifica por routeKey; el servidor solo releva (`hello/init/scene/pointer`); token de Cognito por query param validado con GetUser en $connect (WS no permite headers ni tiene authorizer JWT nativo); acceso por el modelo de compartir existente; conexiones en Dynamo con TTL; cliente reconcilia por (version, versionNonce) con mapa anti-eco + autoguardado 20s. Verificado en vivo: 400 sin token, 401 token inválido, sin errores en logs. La validación multi-navegador la hace el usuario (no se puede simular sin 2 sesiones). Ver `docs/02`, `docs/04`, `docs/05`.

## 2026-07-08 · decisión — "Área destino" renombrada a "Grupo de trabajo" (solo etiqueta)

El usuario pidió cambiar la etiqueta visible "Área destino" por "Grupo de trabajo" en toda la app. Es solo texto: la clave persistida sigue siendo `targetAreaId` y el catálogo compartido sigue siendo `AREA` (regla: las claves no se renombran). Actualizado en el campo del detalle, el filtro (opción "Sin grupo", "Todos"), el chip de filtro activo ("Grupo:"), la columna de la tabla, el resumen del detalle y el mensaje de borrado protegido del backend. Antecede a [[#2026-07-06 · decisión — Área destino en solicitudes]]. También en el mismo cambio: el botón "Cerrar" de los paneles de detalle pasó a "Cancelar" (consistencia con el par Cancelar/Guardar, estándar de textos de acción de docs/06). Docs 02/04/06/15 actualizados.

## 2026-07-08 · incidente — El aviso "desplegando" no se veía en deploys de frontend

El usuario notó que al desplegar solo aparecía "Recargar", no el aviso "Se está publicando una nueva versión". Causa (no era bug de código): el watcher sondeaba `/deploy.json` cada 60s, pero un deploy de frontend dura ~15s → la ventana `status:"deploying"` casi nunca coincidía con un sondeo (los que sí se veían antes eran deploys de backend cdk, ~50s). Descartada caché: deploy.json va con `no-store` y CloudFront lo sirve Miss. Fix en dos partes emparejadas: sondeo del frontend a **20s** (`DEPLOY_POLL_MS`) + **dwell mínimo de 25s** del aviso en `scripts/deploy-flag.sh` (`MIN_DEPLOYING_SECONDS`, marcador epoch entre start y done; si el deploy fue más rápido, `done` mantiene el aviso hasta cumplirlo). Con dwell 25s > sondeo 20s el aviso SIEMPRE se alcanza; backend (~50s) no espera. Verificado en vivo: el deploy tardó 9s y `done` mantuvo el aviso 16s más.

## 2026-07-08 · decisión — Personal (ausencias + saldo de vacaciones) como vista del menú de usuario, no módulo

Gestión de personal del equipo: ausencias tipadas (vacaciones/permiso/incapacidad) + saldo simple por año, sobre las MISMAS personas del workspace (items `PERSON_ABSENCE`). El usuario decidió que NO fuera un módulo del menú lateral sino una **opción "Personal" en el menú del usuario (arriba de Salir)** — función ocasional degradada (estándar #6). Implicaciones: sin clave en el manifiesto; ver = cualquier usuario configurado (el servicio valida perfil), escribir = **solo administradores** (guard `admin=True`); `renderNav` permite `activeModule="staff"` sin entrada de nav. Saldo: días hábiles L-V sin feriados (v1); asignación manual por año. Alternativas descartadas: módulo asignable (sobraba en el menú para algo ocasional), flujo de aprobaciones (esto es coordinación GAD, no RRHH). Pendiente opcional: badge "de vacaciones" en Solicitudes. Ver `docs/02`, `docs/04`, `docs/05`.

## 2026-07-07 · decisión — Librerías de terceros AUTO-HOSPEDADAS en /vendor/ (sin CDNs externos)

El usuario señaló que parte de los usuarios trabajan en laptops corporativas con salida a internet restringida (usan la plataforma porque los dominios de AWS están permitidos) → depender de unpkg/jsdelivr era un RIESGO para el grafo del catálogo (D3), las gráficas del Panel (Chart.js) y Pizarra (React+Excalidraw). Matiz importante: esos usuarios SÍ habían visto el grafo antes (unpkg les pasaba el filtro hasta ahora), así que no estaba roto — se auto-hospeda como blindaje: elimina la dependencia de que ese permiso siga existiendo, de la disponibilidad del CDN y de cambios de política corporativa. TODO vive en `frontend/public/vendor/` (mismo CloudFront, ~7 MB: D3 7.9.0, Chart.js 4.4.1, React 18.2.0, Excalidraw 0.17.6 + excalidraw-assets con fuentes e idiomas; `EXCALIDRAW_ASSET_PATH="/vendor/excalidraw/"`). Regla nueva en AGENTS.md: no cargar desde CDNs externos. Incidente en el camino: `astro check` intentaba analizar los minificados de vendor y abortaba por memoria → `public/vendor` excluido en `tsconfig.json`. Verificado en vivo: los 7 archivos responden 200 desde CloudFront (incl. fuente Virgil y locale es-ES).

## 2026-07-07 · decisión — Módulo Pizarra (Excalidraw) con compartir selectivo y aceptación

Nuevo módulo `draw` ("Pizarra"): lienzo Excalidraw como el "New Drawing" de Obsidian. Modelo definido por el usuario: cada pizarra tiene DUEÑO; se comparte con usuarios concretos y el invitado debe ACEPTAR (banner de invitaciones; rechazar la descarta); sin compartir, solo el dueño la ve; solo el dueño renombra/elimina/comparte/revoca. Editor cargado bajo demanda desde unpkg (React 18 UMD + Excalidraw UMD, patrón D3 — alternativa descartada: empaquetar React en el build Astro vanilla). Escena `.excalidraw` en S3 (bucket de adjuntos, prefijo `drawings/`, presigned) — descartado DynamoDB por el tope de 400 KB. Edición compartida asincrónica (último guardado gana), no tiempo real. Nota operativa: los módulos nuevos no aparecen hasta asignarlos en Administración Y recargar la página (el menú sale del perfil cargado al login). Ver `docs/02`, `docs/04`, `docs/05`.

## 2026-07-07 · decisión — Adjuntos de solicitudes: S3 + presigned, UN punto de subida y relación opcional

Las solicitudes almacenan archivos (pantallazos, pdf, csv…; máx 15 MB) y queries de texto. Estrategia: bucket S3 COMPARTIDO `gad-storage-<env>` con prefijo por app (descartado: bucket del frontend — es público vía CloudFront y su deploy hace `sync --delete`; descartado: binarios en Dynamo/API por topes de 400 KB/10 MB) + presigned PUT/GET; queries inline en Dynamo (se leen/copian, no son binarios). UX iterada con el usuario: primero híbrido (subir en franja Y en cada seguimiento) → se descartó porque dos puntos de subida confunden; quedó **un solo punto** (franja "Adjuntos") + selector **"Relacionar con"** por adjunto (General default, entradas de seguimiento con vista previa del texto, y "+ Nueva nota…" que crea el seguimiento y liga el adjunto en un gesto). Estándar #13 en `docs/06`; detalle en `docs/08`; modelo `ATTACHMENT` en `docs/04`.

## 2026-07-07 · decisión — Filtros de Solicitudes: popover "Filtros" + chips removibles + Área destino

El usuario pidió filtrar por área de entrega y poder combinar solicitante+destino a la vez. Se agregó el filtro y la columna "Área destino" (`targetAreaId`; columna nace oculta, `defaultHidden`) y se rediseñó la barra: en vez de 5 dropdowns siempre visibles (no escala, se satura en ~768px), botón `Filtros ▾` con badge de activos + popover con las dimensiones apiladas + chips removibles por filtro activo (todo visible y reversible; los filtros son AND). Alternativa descartada: un solo filtro "Área" con toggle solicitante/destino (impedía combinarlos). Incidente evitado en revisión: los chips nuevos usaban la clase `.filterChip` que ya usan las píldoras de Estado (01-base.css) — renombrados a `.activeFilterChip*` antes de desplegar. Ver `docs/06` estándar 2.

## 2026-07-07 · estándar — Guardrail check:python ahora cubre TODO el árbol propio

`check:python` compilaba con globs explícitos (`app/*.py`, `repositories/`, `services/`, `scripts/`) y **omitía `app/modules/` y `app/core/`**: un error de sintaxis en un archivo de rutas (p. ej. `workspace_routes.py`) pasaba `npm run check` sin avisar. Cambio: `python3 -m compileall -q -x '(_vendor|__pycache__)' backend/app backend/scripts` — recursivo (cualquier subpaquete futuro queda cubierto solo, no se vuelve a pudrir) excluyendo `_vendor/sqlglot` (terceros, no lo mantenemos). Validado: compila los 44 archivos propios, excluye los 177 de vendor, y una prueba negativa (archivo roto en `modules/`) sale con exit 1. Sigue siendo solo chequeo de sintaxis/compilación, no de runtime.

## 2026-07-07 · incidente — Pestaña retirada (home_resumen) se colaba como módulo de menú

Al quitar `home_resumen` de HOME_TABS (eliminación de la pestaña Resumen), los usuarios que ya tenían la fila `MODULE#home_resumen` guardada la vieron aparecer como entrada de navegación ("Inicio · Resumen") que renderizaba **andamiaje viejo** (`viewCopy` en app.ts: "Proyectos recientes / Validar el primer inicio de sesión con Cognito"). Causa: `_normalize_modules` excluía del menú solo las claves en `HOME_TAB_KEYS`; al salir de ahí, la clave dejó de filtrarse. Fix: (1) `RETIRED_HOME_TAB_KEYS = {"home_resumen"}` en el manifiesto; `_MENU_EXCLUDE_KEYS = HOME_TAB_KEYS | RETIRED` (backend excluye del menú tanto activas como retiradas, sin resolverla como pestaña funcional); (2) se **eliminó el andamiaje muerto** `viewCopy` + el render placeholder de app.ts (nadie lo usaba salvo claves desconocidas) — el fallback ahora muestra el Panel. Lección: al retirar una clave de menú/pestaña, seguir excluyéndola de la navegación (los datos por usuario persisten). Ver `docs/02`.

## 2026-07-07 · decisión — Pruebas de humo automáticas: capacidad bajo demanda (opt-in)

El usuario definió que las pruebas de humo automáticas (para atrapar regresiones de interacción que `npm run check` no ve) son una capacidad **opt-in**: se construyen/corren **solo cuando él lo pida explícitamente**; en cualquier otro caso, deploy normal (check + verificación en preview). Ningún agente debe agregarlas ni ejecutarlas por iniciativa propia. Plan al solicitarse: harness headless (jsdom/Playwright) sobre flujos críticos (CRUD de área/estado, cambio de vista, filtros/búsqueda), como `npm run check:smoke`. Documentado en AGENTS.md y memoria (`verificar-flujos-afectados`).

## 2026-07-07 · estándar — Verificar los FLUJOS afectados (npm run check no atrapa interacción)

Tras varios bugs que el usuario tuvo que cazar (todos compilaban y pasaban `npm run check`), se formalizó la regla: `npm run check` NO detecta regresiones de interacción/lógica. Parte de "terminado": al tocar lógica COMPARTIDA (helper/estado/render que usan varios flujos — máquinas de mostrar/ocultar formularios, cableado de catálogos, sets de claves del manifiesto), re-verificar en el preview CADA flujo que esa lógica controla (crear/editar/cancelar/borrar/"+Agregar nuevo…"/cambiar opción), no solo el que motivó el cambio. Quedó en AGENTS.md (definición de terminado) y en memoria (`verificar-flujos-afectados`, se recuerda cada sesión). Casos de origen: bug de "Agregar área/estado nuevo" y filtración de `home_resumen` (ambos 2026-07-07).

## 2026-07-07 · decisión — Registro de persona con un solo campo de nombre

El campo Apellido se eliminó de la UI (registro y edición): un único campo "Nombre" donde va nombre, nombre y apellido, nombre completo o proveedor. Frontend puro salvo un mensaje: `firstName` guarda lo que se escribe, `lastName` queda vacío (claves persistidas intactas; el backend ya trataba lastName como opcional). Al editar una persona antigua con apellido, el campo muestra su `fullName` completo. Ver `docs/08`.

## 2026-07-07 · incidente — "Agregar área/estado nuevo" no abría el formulario

Regresión del cambio "borrar dentro del flujo de edición": al mover Eliminar dentro del mini-formulario, la función `syncAreaButtons`/`syncStatusButtons` incluyó `if (!isRealX()) form.hidden = true`. Pero "+ Agregar…" tiene value `__new__` (no es un valor real) → el handler de change abría el formulario y el sync lo cerraba de inmediato. Fix: el sync SOLO togglea el lápiz; la apertura/cierre del formulario la manejan los handlers de change/cancel/guardar. Verificado en preview (elegir "Agregar…" deja el form abierto; elegir un área real vuelve a mostrar el lápiz). Lección: no mezclar visibilidad del formulario con la sincronización de botones.

## 2026-07-07 · estándar — Borrado de catálogo dentro del flujo de edición (sin papelera visible)

El usuario señaló que la papelera roja siempre visible junto a los selectores (área/estado) hacía ruido visual. Matiz al estándar icono/texto: **borrar un ítem de CATÁLOGO es una acción rara → vive dentro del mini-formulario de edición** (lápiz → formulario → botón "Eliminar X" en danger, con confirmación y protección backend), no como icono permanente. La papelera visible queda para ítems de fila donde borrar es trabajo diario. Aplicado a área solicitante/destino y estado; documentado en `docs/06` (estándar #5).

## 2026-07-06 · decisión — Área destino en solicitudes (catálogo COMPARTIDO con área solicitante)

Se agregó **Área destino** (`targetAreaId`: a quién va dirigido el trabajo). Decisión clave: **comparte el catálogo `AREA`** con Área solicitante en vez de crear uno aparte — las áreas de la organización son las mismas entidades; un catálogo por campo duplicaría nombres y correcciones. De paso se completó el CRUD de áreas con **eliminar** (faltaba): papelera inline en ambos campos, protegida en backend si alguna solicitud usa el área como solicitante O destino (mismo patrón impedir-y-avisar de estados). El cableado del catálogo se generalizó: crear/corregir/eliminar desde cualquiera de los dos selects actualiza ambos en el DOM sin re-render. Ver `docs/02`, `docs/04`, `docs/05`.

## 2026-07-06 · estándar — Un filtro que aplica debe tener su control visible

Detectado por el usuario en el Tablero de avance: la búsqueda de texto seguía filtrando el tablero pero su input estaba oculto (se buscaba "pendo" en Gestión y el Tablero mostraba "1 de 16" sin forma de ver ni quitar la búsqueda). Regla: **si un filtro aplica a una vista, su control debe estar visible en esa vista** — nunca un filtro invisible. Fix: el buscador + alcance ahora se muestran también en el Tablero; solo el formulario "Nuevo" y Personas quedan exclusivos de Gestión. Ver `docs/02`.

## 2026-07-06 · decisión — Tablero de avance en Solicitudes; se elimina la pestaña Resumen del Panel

El "Resumen operativo" del Panel (contadores + dona + barras de proyectos/tareas/personas) se eliminó: era dominio de Solicitudes metido en el módulo de infraestructura, estaba desactualizado (decía "Proyectos", color fijo por estado) y era decorativo (números sin acción). Se rechazó una primera propuesta de KPIs-filtro; el usuario pidió el formato de sus informes ejecutivos (barras de avance por iniciativa + "¿qué falta?/¿cuándo?" + estatus por estado, estilo PowerPoint/Excel). Resultado: **vistas "Gestión | Tablero de avance"** en Solicitudes con **filtros compartidos** (preparas el filtro en Gestión y presentas en el Tablero; se conservan al alternar). El % de avance es **manual** (`progress` en PROJECT, 0-100) con **auto-sugerencia derivada de tareas** (si el campo está vacío el tablero usa completadas/total; el editor muestra el cálculo junto al campo) — se eligió manual porque es la práctica actual de los informes y casi ninguna solicitud tiene tareas aún. Nombre "Gestión" elegido sobre "Listado" (comunica el trabajo, no la forma). `home_resumen` fuera de HOME_TABS y DEFAULT_NEW_USER_KEYS (la clave por usuario queda inerte); Panel abre en Data Lake. Ver `docs/02`.

## 2026-07-06 · decisión — Facturación: +2 cuentas (mod-datos desa/prod)

Se agregaron al dashboard de Facturación las cuentas `068657603409` (aws-bdr-cta-analitica-mod-datos-desa) y `732517664745` (aws-bdr-cta-analitica-mod-datos-prod), ambas `mode:"assume"`. Proceso completo ejecutado: (1) se creó el rol `gestion-proyectos-cost-reader` en cada cuenta con `grant-hub-cost-explorer.sh` usando el acceso SSO admin del usuario (permission set `aws-ps-admin-analitica-bdr`, que tiene en ambas cuentas) — el rol confía en la Lambda `186281981036:role/gestion-proyectos-dev-api-role` y otorga CE+CloudTrail; (2) se agregaron a `costAccounts` en el CDK; (3) `cdk deploy`. Verificado end-to-end contra AWS real: COST_ACCOUNTS de la Lambda lista las 4, el rol de la Lambda puede AssumeRole los 2 nuevos, y CE responde con datos (mod-desa $1.23, mod-prod $0.09 el mes en curso). Fix cosmético en el script (el echo final imprimía siempre el id del hub). Ver `docs/02` (sección "Cuentas del selector").

## 2026-07-06 · decisión — Filtro "Involucra a" + dropdowns de filtro uniformes

Se agregó el filtro **"Involucra a"** (persona responsable O relacionada) para rastrear a un proveedor por todas sus solicitudes sin depender del buscador (el dropdown "Responsable" solo cubría owner). Además se unificó el ancho de los 4 dropdowns de filtro (antes cada uno se ajustaba a su contenido → se veían inconsistentes): `.filterSelect { flex: none }` + `.filterSelect select { width: 158px; box-sizing: border-box; min-width: 0 }` (un `<select>` toma el ancho de su opción más larga; el ancho fijo lo recorta con "…" y la lista completa igual se ve). Botones de la barra a 34px como los selects. Verificado en preview (4 selects a 158px exactos). Ver `docs/02`.

## 2026-07-06 · decisión — Apellido opcional en Personas (registrar proveedores por un solo nombre)

Se necesitaba registrar proveedores por su nombre (la persona de contacto cambia). El apellido pasó de obligatorio a **opcional** en `create_person`/`update_person` (backend) y en los formularios (se quitó `required` del campo; `fullName` se calcula con `.strip()`). El placeholder del primer campo pasó a "Nombre o proveedor" y hay un hint. De paso se corrigió una recomputación frágil del nombre completo en `update_person` (dependía de `currentLastName` con `_required_text`, que rompería con apellido vacío). Verificado en preview: form con solo nombre = válido. Ver `docs/08`.

## 2026-07-06 · decisión — Búsqueda: control segmentado + match por palabras sin acentos

Los usuarios reportaron que (a) los dos chips de alcance parecían botones y no se entendían, y (b) escribir pocas letras "encontraba algo en cualquier lado" y no lo buscado. Auditoría: la búsqueda hacía substring contiguo sobre un blob (nombre+descr+responsable+miembros; en tareas también prioridad/estado/clave cruda) SIN quitar acentos. Fix: (1) alcance como **control segmentado de una opción** "Buscar en: Todo/Solicitudes/Tareas" (antes dos toggles, con la rareza de que apagar el último no hacía nada); (2) búsqueda **por palabras con AND** + **sin acentos** (normalización NFD); (3) campos enfocados (se quitaron etiquetas de prioridad/estado y clave cruda de tareas — eran el ruido). Verificado con pruebas unitarias de la lógica y preview. Estándar de affordance: un selector de estado no debe verse como botón de acción. Ver `docs/02`.

## 2026-07-06 · decisión — Panel de detalle compacto (inspector) + fechas de solicitud/entrega

El editor de detalle se veía "muy grande": usaba densidad de formulario de aterrizaje. Se rediseñó como **panel de propiedades**: etiquetas pequeñas y tenues (0.74rem, `--muted`), inputs densos (min-height 34, padding 6-9), gap 9; las acciones de catálogo (lápiz/papelera de Área y Estado) pasaron de flotar en su propia línea a **inline a la derecha del select** (`.fieldWithActions`). Se agregaron **Fecha de solicitud** y **Fecha de entrega** (`requestDate`/`dueDate` en PROJECT, opcionales) con `<input type="date">` (calendario nativo + manual dd/mm/aaaa, sin librerías), en fila de 2 columnas. Quedó como estándar #12 en `docs/06`. Verificado en preview (form ~493px vs. el anterior más alto; fechas lado a lado con el picker nativo).

## 2026-07-06 · decisión — CSS saneado: tokens completos + archivo partido + guardrail

Segundo paso (tras la tokenización parcial): (A) se tokenizaron los blancos por propiedad (`color:` → `--on-accent`, resto → `--panel`) y se agregó `--on-accent`; el guardrail encontró 3 hex más que duplicaban tokens (`--bg`, `--line-strong`, `--text`), corregidos. (B) `app.css` (3.561 líneas) se partió en 7 archivos por módulo con prefijo (`01-base`…`07-workspace`), importados en orden en `index.astro`; **verificado byte-idéntico** al concatenar (cascada garantizada igual) y en preview (7 hojas, tokens resuelven, login idéntico). Salvedad honesta: el archivo no estaba limpiamente seccionado, así que `01-base` sigue siendo el más grande (~1.970 líneas: tokens+shell+login+base de workspace); los módulos tardíos (catálogo, admin, home, chat, tabla de solicitudes) sí quedaron en su archivo. (C) guardrail `scripts/check-css-tokens.sh` en `npm run check` (`check:css`): falla si un hex que ya es token aparece fuera de `:root`. **Por qué se había pasado por alto el CSS:** los repasos de escalabilidad apuntaron a lo que falla ruidosamente (datos, backend, rendimiento); la deuda de CSS falla en silencio y `docs/06` (decisiones de diseño) dio falsa sensación de "frontend ya estandarizado". Ver `docs/06` y AGENTS.md.

## 2026-07-06 · decisión — CSS: ampliar tokens y reducir colores hardcodeados

Diagnóstico honesto del `app.css` (3.550 líneas, 1 archivo): tiene tokens (12) y secciones, pero 347 hex hardcodeados fuera de `:root`, muchos duplicando tokens (#0f766e = accent 16×, #ffffff/#fff 39×). Primer paso (alto valor, bajo riesgo): se agregaron 5 tokens (`--surface-muted`, `--text-soft`, `--danger`, `--danger-soft`, `--danger-border`) y se reemplazaron **46** ocurrencias hex → `var()` con un script que OMITE las líneas de definición de custom property (evita auto-referencias `--accent: var(--accent)`). Cada token = el hex exacto → **no-op visual garantizado** (verificado en preview: tokens resuelven a su rgb, login se ve igual). Se dejaron los blancos sin tokenizar (ambigüedad semántica: texto-sobre-accent vs superficie). Pendiente recomendado (medio esfuerzo, NO hecho): partir `app.css` por secciones en varios archivos y un guardrail que marque hex nuevos fuera de `:root`. Los duplicados restantes son reglas divididas estructura/color u overrides de contexto, no código muerto.

## 2026-07-06 · estándar — Responsive obligatorio como parte de "terminado"

El usuario señaló que ya varias veces tuvo que recordar verificar el responsive. Se elevó a **regla dura**: ninguna UI se da por terminada sin probarla en ~1280/~768/~390 px, preferiblemente con el preview real (no solo razonando el CSS). Quedó en AGENTS.md (definición de terminado), `docs/06` (regla #6) y memoria (feedback `responsive-verificar-siempre`, se recuerda cada sesión). Se creó `.claude/launch.json` (servidor `frontend-dev`) para poder verificar en vivo.

## 2026-07-06 · incidente — Responsive de la tabla configurable (overflow horizontal en móvil)

Al hacer la tabla de ancho fijo (`table-layout: fixed`, sección anterior), en móvil la tabla (~1150px) empujaba la página de lado en vez de scrollear dentro de su contenedor. Causa: `.projectTablePanel` es item de grid con `min-width: auto` → se expandía al contenido. Fix: `min-width: 0` en el panel (verificado en preview a 390px: panel 374px, scroll interno OK, sin overflow de página). Segundo hallazgo: mis primeros overrides `@media` no aplicaban porque estaban ANTES de las reglas base de la tabla en el archivo (misma especificidad → gana la más tardía); se movieron a un `@media` posterior. Ambas reglas quedaron documentadas en `docs/06` (reglas al construir UI). También: chips de Estado como tira con scroll lateral y dropdowns 2 por fila en teléfono.

## 2026-07-06 · decisión — Tabla de solicitudes configurable (filtros + columnas + anchos)

Se ampliaron los filtros y se hizo la tabla personalizable. Decisión de diseño (consultada, según estándares): **chips de Estado + dropdowns** para Tipo/Área/Responsable — se descartó "todo dropdown" (degradaba el filtro más común de 1 a 2 clics) y "filtros por columna estilo Excel" (choca con el clic-para-ordenar ya existente y es el más complejo). Se agregó: menú "Columnas" (mostrar/ocultar; "Solicitud" siempre visible) y **anchos arrastrables** (`table-layout: fixed` + colgroup + asa en el th; el texto se recorta con elipsis y ensanchar revela más — resuelve el "ver más de Última actividad"). Columnas y anchos se persisten en localStorage (`gp.projectTable.v1`), no en backend (por navegador es lo sensato para preferencias de vista). Todo frontend. Ver `docs/02_modulos_funcionales.md` y estándar en `docs/06`.

## 2026-07-06 · decisión — Se elimina el bloque "Miembros" duplicado del detalle

"Personas relacionadas" (izquierda) y "Miembros" (panel derecho) mostraban el MISMO dato (`project.members`) con dos nombres distintos — redundante y rompía la consistencia de vocabulario (#9). Además el selector de rol (Responsable/Miembro/Lector) del bloque "Miembros" **no gobernaba ningún permiso** (verificado: la autorización es por `roles` del perfil, no por rol de miembro) y sobrecargaba la palabra "Responsable", que ya existe como campo propio. Se quitó el bloque "Miembros" y su código muerto (`renderMemberRoleControl`, `updateProjectMember`, binding `data-member-role`, CSS `.memberRoleRow`/`.detailList`). Queda una sola lista ("Personas relacionadas") + el campo Responsable. El atributo `role` permanece inerte en los items; el endpoint PATCH /members queda sin uso. Ver `docs/08_proyectos_tareas.md`.

## 2026-07-06 · estándar — Convención icono/texto para acciones (editar=lápiz, borrar=papelera)

Los botones-palabra de los catálogos ("Corregir nombre del área", "Corregir", "Eliminar") hacían ruido y rompían la consistencia: el resto de la app ya edita con ícono de lápiz. Se formalizó la convención (estándar #5 en `docs/06`): editar → lápiz, borrar → papelera roja + confirmación, crear/acción primaria → texto visible; iconos siempre con tooltip (`title`/`aria-label`) para no volverlos gesto oculto. Se agregó `renderDeleteIconButton` en `app.ts` (junto a `renderEditIconButton`) y se aplicó a los catálogos de área y estado. Regla obligatoria para todo módulo nuevo (queda en AGENTS.md).

## 2026-07-06 · decisión — Estados de solicitud como catálogo vivo (con color y borrado protegido)

Los estados dejan de ser un enum fijo y pasan a catálogo vivo (`PROJECT_STATUS`), como las áreas: agregar/corregir/eliminar desde el selector. Dos decisiones (consultadas): (1) color de una **paleta fija** de ~8 tonos —no rueda libre— para mantener disciplina de color y que los estados se distingan de un vistazo; (2) **borrado protegido** —no se puede borrar un estado en uso; el backend avisa cuántas solicitudes lo tienen y pide reasignarlas—. Los 4 semilla (planned/active/paused/closed) se materializan al primer GET usando sus claves como id → las solicitudes existentes calzan sin migración (validado: 7 active, 2 planned/closed, 1 paused, 2 sin estado). Filtros de la tabla ahora derivados del catálogo. Ver `docs/02_modulos_funcionales.md`, `docs/04`, `docs/05`.

## 2026-07-06 · decisión — Seguimiento agrupado por día + hora discreta

Anticipando varias entradas por día, el seguimiento ahora se **agrupa por día** (la fecha va una vez como encabezado fijo, no repetida en cada renglón) y cada entrada muestra su **hora** de registro de forma muy discreta (aún más tenue que el autor, hora de Guatemala desde `createdAt`): `08:15 · GAD Morales, Saul`. Cambio solo de frontend (`createdAt` ya se exponía). Jerarquía visual coherente con los estándares: día > (hora · autor) > texto. Ver `docs/02_modulos_funcionales.md`.

## 2026-07-06 · decisión — El seguimiento muestra su autor (+ NameDirectory compartido)

Cada entrada de seguimiento ahora muestra quién la registró, junto a la fecha y atenuado. El dato ya se guardaba (`createdBy` = correo del autor), solo no se exponía → cambio de visualización sin migración. Como el autor es un *usuario* (correo), no una *persona* del directorio, se resuelve a nombre real con Identity Center. Para no duplicar esa lógica (ya existía en `AthenaMonitorService._resolve_names`), se extrajo a `services/name_directory.py::NameDirectory` (segundo consumidor → extracción, no copy-paste); Athena ahora delega ahí y comparten la caché NAMEMAP. Fallback: nombre → correo → se omite. Ver `docs/02_modulos_funcionales.md`.

## 2026-07-05 · cambio-de-rumbo — Nace la v2 multinube: Plataforma_Inteligencia

Se decidió que la plataforma evolucione a **multinube** (modelo Databricks/Foundry: núcleo portable + adaptadores por nube). Se creó el proyecto hermano `../Plataforma_Inteligencia` (repo git propio) como v2: primitivos portables (Postgres, contenedores/FastAPI, OIDC, Terraform), `core/` sin SDKs de nube (guardrail `check-portability.sh`) y módulos cloud-nativos como plugins. Plan: la v2 alcanza paridad primero EN AWS y reemplaza a esta v1; al arrancar su Fase 1, este proyecto pasa a solo-corrección-de-errores y lo nuevo nace allá. El código de aquí se reutiliza pieza por pieza (mapa en `Plataforma_Inteligencia/docs/03_mapa_reutilizacion.md`). Mientras tanto, este proyecto sigue operando con normalidad.

## 2026-07-05 · estándar — Guardado rápido: merge local + fin del N+1 + botón con estados

El "Guardar" de Solicitudes se sentía lento y ambiguo (¿guardó o presiono de nuevo?). Causa raíz: cada guardado recargaba TODO el workspace, y `GET /api/workspace` hacía 3 consultas DynamoDB por proyecto (N+1, ~31 consultas con 10 solicitudes). Fix: (1) el PATCH fusiona su respuesta en el estado local y repinta, sin recarga completa; (2) el backend trae miembros/tareas/seguimientos de TODOS los proyectos en 3 consultas globales (GSI `byEntityType`) y agrupa en memoria; (3) todo botón Guardar pasa a "Guardando…" deshabilitado al clic y "✓ Guardado" al confirmar. Se descartó la UI optimista (complejidad de reconciliación innecesaria con estas latencias). Quedó como estándar #11 en `docs/06_frontend_ux.md`.

## 2026-07-05 · decisión — Solicitudes clasificadas por "Área solicitante" (catálogo vivo)

Se agregó el campo `requestingAreaId` a las solicitudes con un catálogo de áreas creable desde el propio selector y **editable** (si se registra con error de escritura se corrige y todas las solicitudes lo reflejan, porque referencian por id). Nombre elegido: **"Área solicitante"** — se descartó "Gerencia" (se queda corto: "Recuperación de Cartera" no es gerencia) y "Área" a secas (ambiguo con el área que atiende). Rutas `POST /api/areas` y `PATCH /api/areas/{areaId}`; entityType `AREA`. Ver `docs/02_modulos_funcionales.md`.

## 2026-07-05 · estándar — Bitácora creada + estándar anti scroll-hijacking

Se crea esta bitácora como memoria compartida multiagente (la memoria persistente de Claude Code es privada de ese agente; esto es portable a cualquier modelo). Mismo día: en maestro-detalle apilado, seleccionar una fila hace "peek" (scroll mínimo que deja ver el panel sin perder el listado) + chevron ›/▾ + destello del borde; el salto completo solo con clic en el chevron. Se descartó el auto-scroll total: un clic de selección no debe quitarle el viewport al usuario. Ver `docs/06_frontend_ux.md` (criterio 2) y `docs/Guia 05 - Estandares visuales y UX.canvas` (nueva guía visual de estándares).

## 2026-07-04 · incidente — Deploy colgado ~1 h por custom resource roto

`cdk deploy` se colgó en `InitialDataSeed`: la Lambda auxiliar de custom resources (`AWS679…`) llevaba rota desde 2026-06-17 porque **AWS migró solo su runtime node18→22** (`Cannot find module 'index'`) y CloudFormation espera 1 h fija la respuesta. El rol SSO no tiene `cloudformation:CancelUpdateStack`, así que se reparó la Lambda a mano (`update-function-code` con el asset de `cdk.out`) y el rollback cerró en segundos. Fix de raíz: CDK 2.114→2.261 + CLI 2.1129 (auxiliares en node24, gobernados por CFN). Ojo: `infra/` NO está en el workspace pnpm — `pnpm install` va DENTRO de `infra/`. Guía de diagnóstico en la memoria del incidente; flujo en `docs/17_desarrollo_local_publicacion.md`.

## 2026-07-04 · estándar — Todo deploy avisa a los usuarios conectados

`deploy.json` en el bucket del frontend (no-store): el frontend lo sondea cada 60 s y muestra un aviso discreto durante el despliegue y "Recargar" cuando cambia el buildId. `deploy-frontend.sh` lo maneja solo; deploys de backend/CDK se envuelven con `scripts/deploy-flag.sh start|done`. Motivo: usuarios activos veían comportamientos mixtos a mitad de un despliegue sin explicación. Ver `docs/17_desarrollo_local_publicacion.md`.

## 2026-07-04 · decisión — Rediseño de "Solicitudes" (antes Proyectos y tareas) + 10 estándares de UX

El módulo no resultaba intuitivo; se investigó y la clave fue: **los usuarios no conocen Trello/Asana pero todos conocen Excel** → tabla maestro-detalle en lugar de tarjetas/kanban como vista principal, una sola acción primaria, drag & drop solo como atajo. Se renombró la etiqueta a "Solicitudes" con campo `requestType` (project|report) — **las claves persistidas (`projects`, `tasks`) nunca se renombran, solo etiquetas** (regla general). Los 10 criterios quedaron como OBLIGATORIOS para todo módulo en `docs/06_frontend_ux.md`; módulo en `docs/08_proyectos_tareas.md`.

## 2026-07-08 · decisión — Reporte ejecutivo de solicitudes: el LLM decide contenido, plantillas SVG propias dibujan

Para las juntas que piden "un esquema distinto cada vez", se agregó el Reporte ejecutivo (modal en Solicitudes): preajustes + texto libre → GLM 5 (asíncrono, patrón del chat) responde markdown + spec JSON de UN diagrama que el backend valida y el frontend dibuja con plantillas SVG deterministas (semáforo RAG, barras de avance, línea de tiempo de hitos — Tanda 1 de un catálogo de ~15 acordado). Se descartó que el modelo genere el diagrama (Mermaid): un error de sintaxis del modelo rompería el render en plena junta; con spec validado, la basura degrada a solo-texto. Ver `docs/08_proyectos_tareas.md`.

## 2026-07-04 · incidente — Módulo Proyectos "vacío" por lecturas DynamoDB sin paginar

Al crecer la tabla (items `ATHENA#EXEC`), los `scan/query` de una sola página dejaron de traer los proyectos → el módulo aparecía vacío sin error. Regla dura desde entonces: solo `_query_all`/`_scan_all`/`_query_entity_type` de `BaseRepository` (17 call sites corregidos), GSI `byEntityType` para listados globales, y guardrail ejecutable `scripts/check-dynamo-pagination.sh` dentro de `npm run check`. Ver `docs/04_modelo_dynamodb.md` y `docs/21_guia_nuevo_modulo.md`.

## 2026-07-03 · decisión — Escaneo incremental de Athena (94 s → ~3 s)

El escaneo del monitoreo Athena re-consultaba y re-parseaba todo el rango en cada corrida. Se pasó a arquitectura incremental: items por ejecución (`PK=ATHENA#EXEC`, lint precalculado, TTL 45 d) + cursor de ingesta con solape de 2 h + agregación solo desde DynamoDB. CloudTrail limita ~2 req/s (paralelizarlo no sirve); el paralelismo se aplicó a la API de Athena (8 hilos) y el lint se memoiza por SQL idéntico. Medido: completo 94 s, incremental 2.9 s. Ver `docs/02_modulos_funcionales.md`.

## 2026-07-02 · estándar — Manifiesto único para módulos y pestañas (SOLID)

Módulos/pestañas nuevos se declaran SOLO en `backend/app/modules/manifest.py`: la matriz de Administración, defaults de alta y etiquetas se derivan solos (no se toca `admin.ts`). Mismo período: la clave `home` pasa a mostrarse como "Panel" — se evaluó renombrar claves en DynamoDB y se descartó (migración riesgosa sin beneficio); `_CURRENT_LABELS` impone la etiqueta vigente sobre copias guardadas. Ver `docs/02_modulos_funcionales.md` y `docs/09_admin_accesos.md`.

## 2026-06-25 · cambio-de-rumbo — Rutas nuevas ya NO se registran en el CDK

API Gateway pasó a catch-all `/api/{proxy+}`: una ruta nueva solo se agrega al router del backend. La regla anterior de doble registro (backend + CDK) quedó obsoleta desde esta fecha. Ver `docs/05_api_backend.md`.

## 2026-06 (fines) · decisión — LLM: GLM 5 on-demand en lugar de Claude/Bedrock AgentCore

Una SCP de la organización bloquea Claude y AgentCore en ambas cuentas (solo permite us-east-1/ca-central-1 y restringe modelos). Se descartó pelear la excepción y se adoptó GLM 5 on-demand vía Bedrock para sugerencias SQL y chat (permiso ya aplicado en el hub). Existe un agente clásico exploratorio en el hub (`agent-gad-analitica-bdr`) que NO está conectado a la plataforma. Ver `docs/10_integraciones_aws.md`.
