# Instrucciones para agentes

Este proyecto utiliza contexto documental separado. `AGENTS.md` define reglas transversales y `docs/` constituye la fuente principal de contexto funcional, técnico y operativo.

## Orden recomendado de lectura

1. `README.md`
2. `docs/00_contexto_general.md`
3. `docs/12_guardrails.md`
4. `docs/22_bitacora.md` — cómo llegó el proyecto a su estado actual (decisiones, incidentes, cambios de rumbo).
5. El documento especifico del modulo que se va a modificar.

Para trabajos que creen o validen infraestructura AWS, leer tambien `docs/14_permisos_aws_actuales.md` y `docs/16_credenciales_aws_sso.md`.

## Reglas generales

- Mantener la plataforma simple, clara y rápida.
- Todo texto visible para usuarios y documentación funcional debe estar en español. Mantener nombres técnicos de servicios, comandos, rutas, clases y variables en su forma técnica cuando corresponda.
- Construir una experiencia interna ligera, directa y centrada en el trabajo operativo.
- Mantener la documentación sincronizada con cambios reales — en cada cambio construido: (1) el doc del tema en `docs/`, (2) **este AGENTS.md** cuando el cambio introduzca o modifique reglas, estándares, flujos de publicación o puntos de extensión, y (3) **`docs/22_bitacora.md`** cuando haya una decisión no obvia (con alternativas descartadas), un incidente o un cambio de rumbo: entrada append-only de 3–5 líneas con fecha y tipo, la más reciente arriba, nunca editando entradas pasadas. AGENTS.md es el contrato de entendimiento para cualquier agente: se mantiene magro (reglas + índice), el detalle vive en `docs/` y el porqué histórico en la bitácora.
- **Proyectos hermanos** (`../Agente_Mantenimiento`, `../Proxy_Mantle`, `../Plataforma_Inteligencia`): su documentación es **autocontenida en su propio repo** (regla 2026-07-10) — aquí solo se referencia lo que afecta a esta plataforma (ver `docs/00_contexto_general.md`, sección "Ecosistema"); los cambios de fondo de un hermano se trabajan en su repo, no desde aquí.
- Separar autenticación de autorización.
- Validar permisos en backend y reflejarlos en los elementos visibles del frontend.
- Obtener credenciales mediante SSO y servir el frontend desde S3 privado con CloudFront.
- Usar DynamoDB para autorizacion funcional y datos operativos.
- Usar Glue Catalog para metadata técnica y DynamoDB para contexto funcional.
- Usar Athena para consultas controladas, preview y monitoreo; realizar CRUD mediante los servicios operativos.
- Para AWS, trabajar con el perfil SSO `gestion-proyectos-dev` salvo instrucción contraria.
- Antes de ejecutar acciones AWS relevantes, validar que la sesión siga vigente con STS; si SSO falla por expiración, solicitar al usuario ejecutar `aws sso login --sso-session bdr-fed`.
- Usar el perfil SSO como flujo normal y mantener `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_SESSION_TOKEN` fuera de conversaciones, comandos y archivos del proyecto.
- El workspace usa `pnpm`. El flujo vigente de publicación está en `docs/17_desarrollo_local_publicacion.md`: frontend con `scripts/deploy-frontend.sh` (nunca `s3 sync --delete` sin excluir `config.json`), y **todo deploy (backend o frontend) debe avisar a los usuarios conectados** con `scripts/deploy-flag.sh start|done` (`deploy-frontend.sh` lo hace solo).
- **Acceso a DynamoDB (estándar obligatorio, ver `docs/21_guia_nuevo_modulo.md`)**: nunca `self._table.query/scan` directos — siempre `_query_all`/`_scan_all` de `BaseRepository`; listados globales por tipo vía el GSI `byEntityType` (`_query_entity_type`); todo item nuevo lleva `entityType`; expirables con atributo `ttl`. Verificado por `scripts/check-dynamo-pagination.sh` dentro de `npm run check`.
- **Módulos y pestañas nuevos** se declaran SOLO en `backend/app/modules/manifest.py` (la matriz de Administración, etiquetas y defaults se derivan solos; no tocar `admin.ts`). La clave `home` se muestra como "Panel" y `projects`+`tasks` como "Solicitudes" (cada registro es una solicitud con `requestType`: project|report) — nunca renombrar claves persistidas, solo etiquetas.
- **Catálogos de valores = FUENTE ÚNICA (regla 2026-07-09):** todo conjunto de valores seleccionables (tipos, estados, prioridades, roles…) se define UNA vez y todo lo demás se deriva — nunca escribir las opciones a mano en un `<select>`, filtro o etiqueta. Si el valor **cruza capas**, la fuente es una constante `{key, label}` en el servicio backend publicada en el payload (`get_workspace` → `requestTypes`/`taskStatuses`/`taskPriorities`/`personStatuses`; `get_staff` → `absenceTypes`) y el frontend la recorre (con fallback local mínimo solo para el instante de un deploy cruzado); las listas de claves para validación se DERIVAN del catálogo. Si es **local a un módulo** (p. ej. roles en `admin.ts`), una constante única del módulo alimenta selects y chips. Precedentes ya existentes del patrón: `manifest.py` (módulos), `PROJECT_COLUMNS` (columnas), `costAccounts` (cuentas), catálogos vivos AREA/PROJECT_STATUS (en DynamoDB).
- **Fechas y horas — criterio único (2026-07-09, detalle en `docs/18`):** almacenar SIEMPRE UTC con zona (`datetime.now(timezone.utc).isoformat()`, nunca naive); mostrar instantes SIEMPRE con `timeZone: "America/Guatemala"` explícito (hora del negocio, no la del SO del usuario); las fechas-puras `AAAA-MM-DD` viajan como string sin zona y se formatean SIN convertir (fijarles zona cambiaría el día); el "hoy" de negocio se calcula explícito en Guatemala; los cortes de rango de Athena quedan en UTC (consistencia con CloudTrail).
- Correr **`npm run check`** antes de publicar cualquier cambio (build frontend + Python + estándar DynamoDB + **tokens CSS** + synth CDK).
- **CSS (estándar de estilos):** los estilos viven en `frontend/src/styles/` partidos por módulo con prefijo numérico (`01-base.css` = tokens+shell, `02-catalog`, …, `07-workspace`); se importan EN ESE ORDEN en `index.astro` (la cascada depende de él). Los colores son **tokens** en el `:root` de `01-base.css` (`--accent`, `--panel`, `--on-accent`, `--danger`, `--surface-muted`, `--text-soft`…); NO hardcodear un hex que ya sea un token — `npm run check:css` (guardrail) lo prohíbe. Un color de un solo uso puede ser hex literal; si se repite y representa una decisión de diseño, hacerlo token.
- **Verificar el FLUJO, no solo que compile (parte de "terminado"):** `npm run check` NO detecta regresiones de interacción/lógica (compilan bien y pasan). Antes de publicar cualquier cambio de UI, ejercitar en el preview el flujo afectado, no solo razonarlo. **Regla dura al tocar lógica COMPARTIDA** (un helper o estado que usan varios flujos — p. ej. `syncAreaButtons`/`syncStatusButtons`, el cableado de catálogos, un set de claves del manifiesto, una función de render reusada): re-verificar CADA flujo que esa lógica controla, no solo el que se quería cambiar. Fallos reales por saltarse esto: "Agregar área/estado nuevo" dejó de abrir el formulario (2026-07-07), y `home_resumen` retirada se coló como módulo de menú (2026-07-07). Trampas recurrentes: máquinas de estado de mostrar/ocultar formularios, y retirar una clave de menú/pestaña sin seguir excluyéndola de la navegación.
- **Responsive obligatorio (parte de "terminado"):** ninguna UI nueva o modificada se da por terminada sin verificarla en **~1280 / ~768 / ~390 px**. Preferir verificación real con el preview (`.claude/launch.json` → `frontend-dev`) sobre solo razonar el CSS. Reglas técnicas y trampas conocidas (p. ej. `min-width:0` para tablas `table-layout: fixed`, orden del `@media` respecto a la base) en `docs/06_frontend_ux.md` sección "Responsive".
- **Pruebas de humo automáticas — capacidad BAJO DEMANDA (opt-in), NO por defecto:** existen para atrapar regresiones de interacción que `npm run check` no ve (crear/editar/cancelar/borrar/"+Agregar nuevo…" de área y estado, cambio de vista Gestión↔Tablero, filtros y búsqueda). **Solo se construyen o corren cuando el usuario lo pide explícitamente** ("corre/implementa pruebas de humo" o similar); si no lo pide, el flujo es el normal (`npm run check` + verificación de flujos en el preview + deploy) — no agregarlas ni ejecutarlas por iniciativa propia para no ralentizar cada cambio. Plan cuando se soliciten: harness headless liviano (jsdom o Playwright) que ejercite los flujos críticos, expuesto como `npm run check:smoke` (o dentro de `check` solo si el usuario decide dejarlas permanentes).
- **UI de módulos nuevos o rediseños**: seguir los 11 estándares visuales/usabilidad de `docs/06_frontend_ux.md` (objeto principal primero, maestro-detalle con tabla, una sola acción primaria, disciplina de color, acciones visibles con texto — drag&drop solo como atajo, empty states guiados, guardado con feedback inmediato — botón "Guardando…"/"✓ Guardado", merge local sin recarga completa y sin N+1 en backend, etc.). En maestro-detalle apilado (detalle debajo de la tabla), seleccionar una fila DEBE dar tres señales SIN robar el viewport: chevron ›/▾ por fila, "peek" (scroll mínimo para que el panel asome sin perder el listado; salto completo solo al hacer clic en el chevron) y destello breve del borde del panel (referencia: `revealProjectDetail(full)` en `workspace.ts`). **Convención icono/texto (obligatoria):** editar → lápiz, borrar → papelera roja + confirmación, crear/acción primaria → texto visible; los iconos siempre con `title`/`aria-label`. No usar botones-palabra largos para acciones que ya tienen su ícono (`renderEditIconButton`/`renderDeleteIconButton` en `app.ts`).
- **Animaciones**: sin librerías — CSS para micro-transiciones y Web Animations API para entradas de vista (`animateViewEnter` en `app.ts`), solo en navegación explícita (nunca en repintados de sondeos) y respetando `prefers-reduced-motion` (detalle en `docs/06_frontend_ux.md`).

## Stack técnico (resumen para agentes)

- **Frontend**: Astro 6 estático con una sola página y UI imperativa en TypeScript. `frontend/src/pages/index.astro` contiene el cascarón HTML; `frontend/src/scripts/app.ts` funciona como shell de sesión, navegación, estado y dependencias compartidas; `frontend/src/scripts/modules/` contiene los dominios `home`, `workspace`, `catalog`, `admin`, `chat`, `draw` (Pizarra) y el submódulo `datalake`; los estilos viven en `frontend/src/styles/` partidos por módulo (ver la regla CSS arriba). La navegación muta `state.activeModule`, vuelve a renderizar con `innerHTML` y enlaza listeners en cada render. Verificar cambios con `pnpm build` dentro de `frontend/` (incluye `astro check`).
- **Dependencias frontend**: `@aws-sdk/client-cognito-identity-provider` implementa el login directo contra Cognito (`USER_PASSWORD_AUTH` + `NEW_PASSWORD_REQUIRED`). Librerías pesadas se cargan BAJO DEMANDA **desde `/vendor/` del propio bucket del frontend** (`frontend/public/vendor/`, versiones fijadas): D3 7.9.0 (grafo del catálogo), Chart.js 4.4.1 (gráficas del Panel), React 18.2.0 UMD + Excalidraw 0.17.6 UMD + sus assets (Pizarra). **No cargar desde CDNs externos (unpkg/jsdelivr…)**: hay usuarios en laptops corporativas con salida restringida — hoy unpkg les pasa el filtro (el grafo les funcionaba), pero es un permiso que no controlamos y puede cerrarse; auto-hospedar elimina esa dependencia (decisión 2026-07-07, ver bitácora). `public/vendor` está excluido de `astro check` en `tsconfig.json` (minificados de terceros; analizarlos revienta la memoria).
- **Almacenamiento de archivos (adjuntos y pizarras)**: bucket S3 compartido `gad-storage-<env>-<cuenta>` (privado total, RETAIN, CORS solo al origen CloudFront), con **prefijo por aplicación** (`gestion-proyectos/`) e IAM de la Lambda acotado a ese prefijo. Los binarios NUNCA pasan por la API (tope 10 MB de API Gateway) ni por DynamoDB (tope 400 KB): subida con presigned PUT directo del navegador, lectura con presigned GET corta. El acceso a S3 vive solo en los adaptadores (`services/attachments.py`, `services/drawings.py` — puerto BlobStore); al borrar la entidad se borra su objeto S3. Detalle: adjuntos en `docs/08`, Pizarra en `docs/02`, modelo en `docs/04`.
- **Sesión**: tokens Cognito en `sessionStorage` (`gestionProyectosAuth`); módulo activo persistido en `gestionProyectosModule`. Configuración runtime en `/config.json` (se obtiene con `fetch` al arrancar; no forma parte del bundle).
- **Backend**: Lambda Python en `backend/app/`, con handler delgado, router por registro, módulos de rutas, servicios y repositorios por dominio; API Gateway expone sus rutas. Validar sintaxis con `npm run check:python` desde la raíz.
- **Infra**: CDK TypeScript en `infra/` (stack único `infra/lib/gestion-proyectos-stack.ts`); deploy con `npm run infra:deploy` (perfil SSO `gestion-proyectos-dev`).
- **Datos**: DynamoDB single-table (autorización funcional, datos operativos y caché del catálogo) + Glue Catalog (metadata técnica, sincronizada a DynamoDB).
- **Grafo del catálogo**: mantener render en Canvas 2D con culling por viewport, LOD de etiquetas y picking por quadtree para escalar a miles de nodos (detalle en `docs/07_catalogo_datalake.md`). Esta decisión sustituye el render SVG por nodo por razones de rendimiento.
- **Verificación completa**: `npm run check` en la raíz (build frontend + sintaxis Python + estándar de acceso a DynamoDB + synth de CDK).

## Documentos por tema

- Arquitectura: `docs/01_arquitectura_aws.md`
- Módulos: `docs/02_modulos_funcionales.md`
- Seguridad: `docs/03_seguridad_accesos.md`
- DynamoDB: `docs/04_modelo_dynamodb.md`
- Backend/API: `docs/05_api_backend.md`
- Frontend/UX: `docs/06_frontend_ux.md`
- Catálogo Data Lake: `docs/07_catalogo_datalake.md`
- Proyectos y tareas: `docs/08_proyectos_tareas.md`
- Administración: `docs/09_admin_accesos.md`
- Integraciones AWS: `docs/10_integraciones_aws.md`
- Fases: `docs/11_fases_implementacion.md`
- Backlog: `docs/13_backlog_inicial.md`
- Permisos AWS actuales: `docs/14_permisos_aws_actuales.md`
- Estado de implementación: `docs/15_estado_implementacion.md`
- Credenciales AWS SSO: `docs/16_credenciales_aws_sso.md`
- Servicios AWS en contexto y comportamiento runtime: `docs/18_servicios_y_runtime.md`
- Paso a producción: `docs/19_paso_a_produccion.md`
- Desarrollo local y publicación (incluye aviso de despliegue): `docs/17_desarrollo_local_publicacion.md`
- Guía para construir un módulo nuevo (estándares obligatorios): `docs/21_guia_nuevo_modulo.md`
