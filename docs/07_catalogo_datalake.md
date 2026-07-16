# Catálogo Data Lake

## Objetivo

Permitir que usuarios autorizados exploren bases, tablas y columnas del Data Lake con contexto funcional entendible.

## Separación de responsabilidades

```text
Glue Catalog = metadata técnica
DynamoDB = contexto funcional
Athena = preview o consulta controlada
```

## Información desde Glue Catalog

- Bases de datos.
- Tablas.
- Columnas.
- Tipos de datos.
- Ubicación técnica si aplica.
- Particiones si aplica.

## Multi-cuenta (2026-07-15)

Varias cuentas de la org replican el hub con bases de datos **homónimas pero de
contenido distinto** (p. ej. `arc_dev` tiene 11 tablas en el hub y 33 en la
cuenta app). El módulo explora el Glue de UNA cuenta a la vez:

- **Selector de cuenta** en el sidebar (patrón del selector de Facturación).
  Fuente única: `catalogAccounts` en el stack CDK → env var `CATALOG_ACCOUNTS`
  → `services/catalog_accounts.py`. La PRIMERA entrada es la **default: el hub
  `396913696127`** (fab-datos prod), que es el catálogo real que la plataforma
  ya usa para Athena, monitoreo y chat SQL. La cuenta app es réplica de pruebas.
- **Acceso cross-account**: mode `assume` reutiliza el rol
  `gestion-proyectos-cost-reader` del hub (su política `AthenaIngestionControl`
  incluye `GlueRead` ampliado a `database/*` y `table/*`, 2026-07-15 — ver
  `docs/permisos_hub.md`); mode `direct` usa el rol de la Lambda.
- **Namespace por cuenta en DynamoDB**: toda llave del catálogo lleva la cuenta
  (`CATALOG#<cuenta>#…`, `TABLE#<cuenta>#<db>#<tabla>`, `META#<cuenta>`), ver
  `docs/04_modelo_dynamodb.md`. La documentación previa a multi-cuenta se migró
  al namespace del hub (las 11 tablas documentadas de `stage_staging` existen
  idénticas allí; el índice de uso ya provenía del Athena del hub).
- Los consumidores internos (`sql_context` para chat/SQL, `athena_monitor`,
  dashboard de Inicio) usan `CatalogRepository()` sin cuenta = la default (hub).
- Las stats S3 de la ficha técnica se calculan con el cliente S3 de la cuenta
  app (bucket policies cross-account donde existan); si un bucket del hub no es
  accesible, la ficha degrada a "no disponible" sin romper el sync.

## Información guardada en DynamoDB

Contexto de tabla (item `TABLE#db#tabla / CONTEXT`):
- `description` — descripción funcional (qué representa).
- `usagePrimary` — uso principal (para qué se usa); alimenta RAG y onboarding.
- `domain` — dominio de negocio. **Texto libre con sugerencias**: un `<datalist>` combina valores recomendados (Comercial, Riesgo, Finanzas, Operaciones, Canales, Clientes, Datos/TI) con los que ya se hayan guardado en el catálogo; el analista puede elegir uno o escribir uno nuevo.
- `responsible` — responsable funcional.
- `sensitivity` — sensibilidad. Texto libre con sugerencias (Interna, Confidencial, PII, Financiera, Restringida + valores ya usados).
- `status` — estado del contexto. Texto libre con sugerencias (Borrador, Pendiente revisión, Aprobado + valores ya usados); evita que RAG consuma lo no validado.
- `usageNotes` — reglas de uso / limitaciones.

Contexto de columna (item `TABLE#db#tabla / COLUMN#col`):
- `description` — descripción funcional.
- `sensitivity` — sensibilidad por columna (vacío = hereda de la tabla); texto libre con las mismas sugerencias que la tabla. Una tabla "interna" puede tener columnas PII.
- `sampleValue` — ejemplo de valor (texto libre que escribe el analista; NO se auto-extrae para no exponer PII real).
- `notes` — notas internas / reglas.

Los campos `obligatorio` de la propuesta V1 no se imponen por bloqueo en frontend (evita fricción); el progreso de documentación invita a completarlos. La obligatoriedad real corresponde a un futuro flujo "Enviar a revisión".

## Relación tabla-proyecto

Una tabla puede asociarse a uno o varios proyectos mediante `PROJECT_TABLE`.

Esto permite mostrar qué datos usa cada proyecto y controlar visibilidad funcional.

## Preview con Athena

Athena solo debe usarse para consultas controladas:

- Límite de filas.
- Columnas permitidas.
- Las consultas se construyen en servicios backend a partir de operaciones permitidas.
- Validación previa de permisos.
- Registro de auditoría cuando aplique.

## Visibilidad

La visibilidad del catálogo se calcula por usuario a partir de permisos de módulo, proyecto, tabla y reglas funcionales.

## Estado implementado

### Backend

- `backend/app/repositories/glue.py`: `GlueRepository` lee bases, tablas y detalle de tabla; recibe el cliente Glue de la cuenta activa (directo o vía AssumeRole, ver `services/catalog_accounts.py`).
- `backend/app/services/catalog.py`: `CatalogService(account)` con `list_databases`, `list_tables`, `get_table`, `sync_table`, `sync_database`, `start_sync_all`, `run_sync_all` (recorre TODAS las cuentas habilitadas), `save_table_context` y `save_column_context`.
- La metadata sincronizada se guarda como cache en DynamoDB (`CatalogRepository.put_catalog_database/put_catalog_table/put_catalog_sync_meta`); el frontend lee desde el cache, no desde Glue en línea.
- El sync es **diferencial**: cada tabla de Glue se compara por `UpdateTime` (guardado como `glueUpdatedAt` en el item de caché) y solo se reescriben las tablas nuevas o modificadas — diseñado para data lakes grandes en crecimiento. Las tablas que ya no existen en Glue (**huérfanas**) se eliminan del caché al final del sync de cada base. El contexto funcional vive en items separados (`TABLE#db#tabla / CONTEXT|COLUMN#...`) y mantiene un ciclo de vida administrado por usuarios. Los endpoints de sync devuelven `updated` y `removed` además de `tableCount`.
- El sync global es asíncrono: `POST /api/catalog/sync` auto-invoca la Lambda con `InvocationType=Event` y payload `{"action": "catalog_sync_all"}`. No hay regla de EventBridge (pendiente acordado); `handler.py` acepta `source == "aws.events"` como entrada futura.

### Rutas API

| Ruta | Método | Función |
| --- | --- | --- |
| `/api/catalog` | GET | Listar bases de datos |
| `/api/catalog/{database}` | GET | Listar tablas de una base |
| `/api/catalog/{database}/{table}` | GET | Detalle de tabla con columnas |
| `/api/catalog/sync` | POST | Sync global asíncrono |
| `/api/catalog/{database}/sync` | POST | Sync de una base |
| `/api/catalog/{database}/{table}/sync` | POST | Sync de una tabla |
| `/api/catalog/{database}/{table}/context` | PUT | Contexto funcional de tabla |
| `/api/catalog/{database}/{table}/columns/{column}/context` | PUT | Contexto funcional de columna |

Todas requieren el módulo `catalog` habilitado para el usuario. Todas aceptan
`?account=<cuenta>` (whitelist `CATALOG_ACCOUNTS`); sin el parámetro operan
sobre la cuenta default (el hub). `GET /api/catalog` devuelve además `account`
y `accounts` para armar el selector del frontend.

### Frontend

#### Búsqueda

- **Dos modos.** Por defecto, búsqueda **exacta** (keyword). Un toggle `≈ Avanzada` activa la búsqueda **semántica** (2026-07-15).
- **Búsqueda avanzada (semántica, toda la cuenta):** encuentra tablas **por significado** en TODAS las bases de la cuenta a la vez (no solo la seleccionada) — "fecha de corte" halla la tabla cuya columna se llama/describe "cutoff". Reutiliza el índice de embeddings genérico (`core/embeddings.py`, namespace `catalog:<cuenta>`); el documento vectorizado por tabla = nombre + descripción Glue + contexto funcional + nombres/descripciones de columnas. Es **híbrida** (realza coincidencias literales), devuelve una lista plana ranqueada (badge "≈ significado"/"coincidencia") y al hacer clic navega a esa base + tabla. Endpoint `GET /api/catalog/search?q=&account=` → `CatalogService.search_semantic`. Indexado on-write al guardar contexto de tabla/columna y al sincronizar; borrado del vector con las huérfanas; backfill idempotente `catalog_embeddings_backfill` (corrió sobre el hub: 595 tablas). Verificado E2E. **Mecánica y modelo de datos en `docs/23` §9.** El diccionario semántico se enriquece solo conforme se documentan tablas y columnas.
- Búsqueda **exacta** con chips de alcance combinables: `Tabla`, `Contexto`, `Columna`, `Desc. columna`. Coincidencia parcial, insensible a mayúsculas.
- Buscar por `Columna` o `Desc. columna` evalúa las columnas de cada tabla usando la caché de detalles (`state.catalogTableCache`). Como Glue solo entrega columnas por tabla, al activar esos alcances se precargan en segundo plano los detalles faltantes (helper `ensureCatalogTableDetails`, 6 peticiones en paralelo) y la lista se refina conforme llegan, con aviso "Cargando columnas…".
- Detalle de tabla con columnas, tipos y contexto funcional editable.
- El contexto de columnas (descripción, sensibilidad, ejemplo de valor, notas) se edita con guardado masivo: en vez de un botón por columna, una barra fija al pie del detalle muestra "Guardar N cambios" y guarda en paralelo solo las columnas modificadas (cada una con su `PUT` de contexto). Las columnas con cambios sin guardar se marcan con un punto; al cambiar de tabla con cambios pendientes se pide confirmación. Los textarea crecen con el contenido.
- Sobre la lista de columnas hay un indicador de progreso ("X de N documentadas" con barra) y filtros: Todas / Sin descripción / Sensibles / Llaves (`id`/`_id`). El progreso se actualiza en vivo al escribir/guardar.

#### Ficha técnica (tabla y base de datos)

En el detalle de tabla y en cada base de datos del sidebar se muestra una ficha automática (solo lectura, colapsable) con metadata de Glue y de S3:
- **Glue** (cacheada en el sync, solo tabla): formato físico (`format`, derivado de `classification` o el SerDe), particionada por (`partitionKeys`), fecha de creación (`glueCreatedAt`), última actualización de esquema (`glueUpdatedAt`), número de columnas, ruta S3 (`location`).
- **S3** (calculada en el sync y guardada en DynamoDB): tamaño total, número de archivos y frescura ("Datos hasta:" = última modificación de objetos). **Se calcula durante el sync, no en cada consulta** — la ficha lee del caché y abre instantánea (los datos reflejan el último sync). Importante: el tamaño/frescura **NO** puede atarse a la condición diferencial de Glue, porque el `UpdateTime` de Glue solo cambia con la definición (esquema/ubicación) y NO con las cargas diarias de datos; si se atara, una tabla con carga diaria pero sin cambio de esquema nunca actualizaría su tamaño y la frescura sería incorrecta. Por eso las stats se recalculan en cada sync. El cálculo (`_compute_database_stats`) es un **listado dirigido por tabla** (cada tabla lista solo su prefijo, lee únicamente sus objetos → exacto, sin truncarse por objetos ajenos del bucket) ejecutado **en paralelo con hilos** (`ThreadPoolExecutor`, 12 workers; el cliente boto3 es thread-safe). El agregado de la BD es la suma de las stats de sus tablas. Las stats por tabla se guardan en el item con `update_catalog_table_stats` (no reescribe la metadata Glue, preserva el sync diferencial de Glue); el agregado de la BD se guarda en el item `CATALOG#DB`.
- Lectura: `GET /api/catalog/{db}/{table}?stats=1` (tabla) y `GET /api/catalog/{db}?stats=1` (agregado de la BD) devuelven las stats desde el caché. Requiere que el rol de la Lambda tenga `s3:ListBucket` sobre el bucket (lado app) y, para buckets cross-account del hub, una bucket policy que liste el rol (ver `docs/19_paso_a_produccion.md`). Si un bucket no es accesible, la ficha muestra "no disponible" sin romper el resto. Antes del primer sync con esta función, las stats aparecen como "Aún no calculado. Sincroniza…".

#### Reporte CSV (por base de datos)

En el encabezado de la base de datos seleccionada, un botón con ícono de documento+descarga (a la izquierda del ícono del grafo) genera un **CSV descargable para Excel** (`catalogo_<base>_<fecha>.csv`, con BOM UTF-8 para acentos). Alcance = la base seleccionada: **todas sus tablas** y **una fila por columna** con el contexto de tabla repetido (cómodo para tablas dinámicas). Columnas: Base de datos, Tabla, Descripción tabla, Uso principal, Responsable, Dominio, Sensibilidad tabla, Estado, Notas de uso, Formato, Ruta S3, Columna, Tipo, Partición, Descripción columna, Sensibilidad columna, Ejemplo, Notas columna. Antes de exportar precarga el detalle de las tablas que falten en caché (reusa `ensureCatalogTableDetails`, el mismo helper del grafo). La exportación se construye completamente en el cliente (`downloadCatalogReport` en `catalog.ts`) a partir de los datos ya cargados y evita procesamiento adicional en Lambda.

#### Grafo de relaciones (Canvas 2D)

El grafo se renderiza en Canvas 2D (no SVG ni DOM) para escalar a catálogos grandes (probado con 167 tablas y miles de columnas; margen estimado hasta ~50k nodos; el siguiente escalón sería WebGL). D3 v7 se carga bajo demanda desde CDN (`unpkg.com/d3@7`) y se usa solo para `d3-force` (tablas), `d3-zoom` (cámara), quadtree (picking) y timers.

Arquitectura del render (`renderGraphModal` en `frontend/src/pages/index.astro`):

- Layout: clusters por base de datos; cada tabla es una esfera con sus columnas distribuidas por espiral de Fibonacci (3D proyectado: hemisferio trasero detrás de la tabla, frontal delante, tamaño y opacidad según profundidad `z`). Solo las tablas participan en la simulación de fuerzas; las columnas van ancladas rígidamente a su esfera.
- Rendimiento: culling por viewport, render bajo demanda (dirty flag, 0% CPU en reposo), LOD de etiquetas (tablas siempre; columnas solo en foco/hover o zoom > 1.5x con presupuesto de 500 por frame), picking con quadtree, HiDPI hasta 2x.
- Interacción: scroll o dos dedos = pan; pellizco o Cmd/Ctrl+rueda = zoom; clic = seleccionar; Shift+clic = ruta BFS entre dos nodos; clic derecho = abrir la tabla en el catálogo; Esc = cerrar. La rotación tipo trackball se activa con clic sostenido sobre el núcleo y admite arrastre horizontal, vertical o diagonal; cada tabla acumula su orientación en una matriz 3×3. Doble clic restaura la orientación original. Seleccionar una columna desde el inspector o el buscador gira la esfera mediante animación eje-ángulo hasta traerla al borde frontal visible.
- Estados visuales: sin selección, las uniones FK/compartidas están ocultas (vista limpia); aparecen al seleccionar, buscar o trazar ruta. Parallax 2.5D transitorio de la capa de columnas al desplazarse. Minimapa navegable, inspector lateral y filtros por tipo de relación y base de datos.
- Relaciones heurísticas: FK por sufijo `_id` contra nombres de tabla; columnas compartidas por nombre igual entre tablas. Las columnas de partición se excluyen para no generar relaciones falsas.
- Al abrir el grafo se precargan los detalles de todas las tablas (misma caché que la búsqueda), así abre completo con las relaciones ya detectadas.

### Visibilidad del hub — resuelta con AssumeRole + grants LF DESCRIBE (2026-07-15)

La vía elegida NO fue resource links de Lake Formation sino **AssumeRole al rol
del hub** (`gestion-proyectos-cost-reader`, el mismo de Facturación/Athena):
el selector de cuenta enruta al Glue del hub directamente y la caché DynamoDB
separa por cuenta. El plan anterior (resource links por CDK) queda descartado
salvo que aparezca una necesidad de consultar tablas del hub por Athena local.

**OJO Lake Formation:** IAM solo no basta. El primer sync del hub devolvió 6 de
14 bases — LF **filtra silenciosamente** `GetDatabases`/`GetTables` en las bases
gobernadas (`data_mart` y otras 7 no aparecían; sin error, solo ausentes). Se
aplicaron grants LF `DESCRIBE` al rol sobre las 14 bases y sus tablas
(`TableWildcard`), tras lo cual el sync las trae todas. **Una base NUEVA del hub
necesita su grant `DESCRIBE` (base + TableWildcard) para aparecer en el
Catálogo** — comando en `docs/permisos_hub.md` (Mec. 1c).
