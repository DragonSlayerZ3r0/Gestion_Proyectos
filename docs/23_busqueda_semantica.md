# 23 · Búsqueda semántica (embeddings) y búsqueda híbrida

Spec técnico del subsistema de embeddings y de cómo el **Reporte ejecutivo** lo
usa. El *por qué* y el *cuándo* (decisiones, alternativas descartadas) están en la
bitácora (`docs/22`, entrada 2026-07-15); aquí está el *cómo funciona*.

Introducido el 2026-07-15 porque el reporte volcaba TODO el portafolio al LLM en
cada consulta — no escala, y `llm.py` **lanza error** (no trunca) pasados 60K
caracteres. El objetivo es poder preguntar **bajo cualquier contexto** ("qué hizo
un usuario", "qué hay pendiente", temas por concepto) sin meter todo al modelo.

---

## 1. Arquitectura en tres capas

```
core/embeddings.py            GENÉRICO — cero imports del proyecto (boto3 + stdlib)
  ├─ EmbeddingConfig          toda la parametrización (dataclass)
  ├─ TitanEmbedder            adapter Bedrock (texto → vector)
  ├─ DynamoVectorStore        adapter DynamoDB (persistir + buscar por coseno)
  └─ EmbeddingIndex           fachada: index() / search() / delete()
        ▲
services/embedding_index.py   CABLEADO del dominio — Titan vía hub, namespaces
  ├─ solicitud_index()          solicitud/seguimiento, helpers best-effort,
  └─ seguimiento_index()        backfill_all()
        ▲
services/exec_report.py       CONSUMIDOR 1 — búsqueda de dos pasos del reporte
services/catalog.py           CONSUMIDOR 2 — búsqueda avanzada de tablas (§9)
workspace_routes.py           CONSUMIDOR 3 — búsqueda avanzada de solicitudes (§11)
```

**Regla de reuso:** `core/embeddings.py` no conoce solicitudes, hubs ni dominios —
solo `(docId, texto, meta)`. Se copia tal cual a plataformas hermanas
(Plataforma_Inteligencia, Agente_Mantenimiento). Un módulo nuevo con búsqueda
semántica es otra instancia de `EmbeddingIndex` con su propio `namespace`.

**Segundo core genérico — `core/query_planner.py` (§12):** convierte una consulta en
lenguaje natural en **filtros estructurados exactos + concepto semántico**. También
es genérico (cero imports del proyecto, LLM inyectado): cada módulo solo **declara sus
campos filtrables** (`FilterField`), que son por definición específicos de su dominio;
el "cerebro" (prompt + parseo) es compartido. Resuelve el caso que la semántica pura
NO puede: "solicitudes donde el responsable sea Diego" (filtro exacto, no un tema).

---

## 2. `EmbeddingConfig` — qué se parametriza

| Campo | Para qué |
| --- | --- |
| `table_name` | Tabla DynamoDB (otra plataforma → otra tabla, sin más cambios). |
| `namespace` | **Segmenta dominios en la misma tabla** (p. ej. `solicitud`, `seguimiento`). Los vectores de un namespace no se mezclan con otro. |
| `model_id` / `dimensions` | Modelo de embeddings y tamaño del vector. |
| `region`, `top_k`, `max_input_chars` | Región, tope de resultados por defecto, recorte defensivo del texto. |
| `bedrock_session_provider` | Callable → sesión boto3 para **Bedrock**. En esta app asume el rol del hub (Titan vive ahí). `None` = credenciales del entorno. |
| `table_session_provider` | Callable → sesión boto3 para la **tabla**. `None` = credenciales del entorno (la cuenta de la app). |

Los **dos proveedores son independientes a propósito**: aquí Bedrock está en el hub
(assume-role) pero la tabla está en la cuenta app (rol propio de la Lambda). Una
hermana con Bedrock en su misma cuenta no pasa ninguno.

---

## 3. `DynamoVectorStore` — cómo se guarda y se busca un vector

### Ítem (uno por documento vectorizado)

```
PK          = EMBED#<namespace>#<docId>
SK          = EMBED#<namespace>
entityType  = EMBEDDING#<namespace>      ← clave del GSI byEntityType (proyección ALL)
docId       = <id del documento>          (solicitud → projectId; seguimiento → updateId)
vec         = Binary                       float32 empacado con struct (`<Nf`); 256 dims = 1 KB
dim         = 256
srcHash     = sha256(texto)[:16]           huella del texto de origen (idempotencia)
meta        = { projectId, name | date, author… }   metadatos que el consumidor quiere de vuelta
updatedAt   = ISO-8601
```

- **Vector como Binary, no como lista de números.** `struct.pack("<256f", *vector)`
  → 1 KB fijo. Empacar en float32 (no el JSON de 256 floats) mantiene el ítem muy
  por debajo del tope de 400 KB de DynamoDB y ahorra ancho de banda al leerlos
  todos para el coseno. Al leer: `struct.unpack`.
- **`srcHash` = idempotencia.** `index()` calcula el hash del texto; si coincide con
  el guardado, **no re-embebe** (ni gasta Titan ni reescribe). Editar un seguimiento
  con el mismo texto no hace nada; cambiarlo re-embebe.

### Búsqueda (coseno por fuerza bruta)

`nearest(query_vec, top_k, min_score)`:

1. **Query al GSI** `byEntityType` por `entityType = EMBEDDING#<namespace>` → trae
   SOLO los vectores de ese namespace, con su `vec` completo (proyección ALL).
   Paginado con loop de `LastEvaluatedKey` (respeta la regla del proyecto aunque el
   módulo no herede de `BaseRepository`).
2. **Coseno** de cada vector contra el de la consulta: `dot / (‖q‖·‖v‖)`. Los
   vectores de Titan salen **normalizados** (`normalize: true`), así que el coseno
   es casi el producto punto; el cálculo completo se deja por robustez.
3. Filtra por `min_score`, ordena descendente, devuelve `top_k` como
   `[{docId, score, meta}]`.

**Por qué fuerza bruta y no OpenSearch/pgvector.** A escala de miles de ítems son
décimas de segundo en la Lambda; ~1 KB por vector → 5,000 solicitudes = 5 MB. No
justifica un cluster (~$700/mes) ni infra nueva. Si algún día se superan ~20-30K
ítems, el mismo dato migra a S3+numpy o a un índice real **cambiando solo el
adapter `DynamoVectorStore`** — los consumidores (que solo llaman `search()`) no se
tocan.

---

## 4. `EmbeddingIndex` — la fachada

- `index(doc_id, text, meta, updated_at)` — upsert **idempotente** (por `srcHash`).
  Texto vacío → borra el vector. Devuelve `True` si re-embebió.
- `search(query_text, top_k, min_score)` — embebe la consulta y devuelve los
  vecinos por coseno.
- `delete(doc_id)` — borra el vector.

---

## 5. Cableado del dominio (`services/embedding_index.py`)

- **Modelo:** Amazon **Titan Text Embeddings V2** (`amazon.titan-embed-text-v2:0`),
  256 dims, normalizado. Nativo de Amazon → **la SCP que bloquea a Claude no aplica**
  (no pasa por Marketplace, on-demand en us-east-1). ~$0.02/millón tokens. Se invoca
  asumiendo el rol del hub (mismo patrón que `LlmService`). Permiso: ARN de Titan en
  la inline `BedrockLLMInvoke` del hub (`permisos_hub.md` 1d).
- **Namespaces:** `solicitud` (nombre + descripción; `docId = projectId`),
  `seguimiento` (texto de la bitácora; `docId = updateId`) y `catalog:<cuenta>`
  (tablas del Catálogo; `docId = <db>#<tabla>` — ver §9).
- **Indexado on-write BEST-EFFORT.** Los helpers `safe_index_*` / `safe_delete`
  envuelven todo en try/except: **si Titan o el hub fallan, el guardado del dato NO
  se rompe** (se registra en el log y el vector queda pendiente — ver "Recuperación"
  abajo). Enganchados en `workspace.py` con import diferido (si el módulo de
  embeddings tuviera un problema, el CRUD sigue vivo). Costo añadido al guardado:
  ~150 ms en caliente (imperceptible; los seguimientos se escriben a ritmo humano).

### 5.1. Actualización on-write — cada operación (el índice sigue a los datos)

El vector se mantiene sincronizado en el MISMO request que guarda el dato. Reglas
exactas (todas best-effort; ninguna rompe el guardado si falla):

| Operación (en `workspace.py`) | Qué le pasa al índice |
| --- | --- |
| **Crear solicitud** (`create_project`) | Indexa el vector `solicitud` (nombre + descripción). |
| **Editar solicitud** (`update_project`) | Re-indexa **solo si cambió `name` o `description`** (los campos que se vectorizan). Editar estado/fechas/responsable NO llama a Titan. |
| **Borrar solicitud** (`delete_project`) | **Borrado en cascada**: borra el vector de la solicitud **y el de cada uno de sus seguimientos** (junta los `updateId` antes de borrar los items). |
| **Crear seguimiento** (`create_project_update`) | Indexa el vector `seguimiento` (el texto). |
| **Editar seguimiento** (`update_project_update`) | Re-indexa **solo si cambió `text`** (editar solo la fecha NO llama a Titan). |
| **Borrar seguimiento** (`delete_project_update`) | Borra su vector. |

**Doble candado contra trabajo inútil:**
1. El hook solo dispara cuando cambió un campo vectorizado (tabla arriba).
2. Aunque dispare, `EmbeddingIndex.index()` es **idempotente por `srcHash`**: si el
   texto resultante es idéntico al ya indexado, **no re-embebe** (ni gasta Titan ni
   reescribe el ítem). Texto vacío → borra el vector.

Es decir: el índice **siempre refleja el estado actual** de nombres, descripciones y
seguimientos, pagando Titan únicamente cuando el texto realmente cambió.

### 5.2. Recuperación (qué pasa si un indexado on-write falló)

Como es best-effort, un fallo transitorio de Titan/hub deja un vector **desactualizado
o ausente** — el dato se guardó bien, solo su vector quedó atrás. NO hay reparación
automática en cada búsqueda (se evitó a propósito: añadiría latencia y llamadas a
Titan en la ruta de lectura). Se recupera por dos vías, ambas idempotentes:

1. **La próxima edición** de ese texto lo re-indexa (el `srcHash` no calzará → re-embebe).
2. **Re-ejecutar el backfill** (`embeddings_backfill`): recorre todo y re-embebe solo
   lo que cambió. Seguro de correr cuando sea (p. ej. tras un incidente de Bedrock).

Efecto práctico de un vector rezagado: esa solicitud/seguimiento podría no aparecer
por la vía **semántica** hasta recuperarse — pero la vía **estructurada/literal** del
planificador (autor, estado, fecha, palabra exacta) la sigue encontrando, porque esa
consulta va contra los datos en vivo, no contra los vectores.

### 5.3. Backfill (carga inicial / reparación masiva)

`backfill_all()` indexa TODO lo existente (idempotente por hash). Se dispara con la
acción `embeddings_backfill` del handler:
`aws lambda invoke --function-name gestion-proyectos-dev-api --payload <base64 de {"action":"embeddings_backfill"}> out.json`.
Devuelve conteos (`{solicitudes, seguimientos, errores}`). Re-ejecutarlo es seguro
(omite lo que no cambió). Uso: primera vez (ya corrido el 2026-07-15) y reparación
masiva tras un incidente.

---

## 6. Búsqueda HÍBRIDA — el reporte de dos pasos (`services/exec_report.py`)

El punto clave: **"poder buscar en todo" ≠ "meter todo al contexto del modelo"**. La
base ya puede buscar en todo; lo que se resuelve es que el modelo reciba solo la
rebanada relevante para *cada* pregunta.

### Paso 1 — Planificador (LLM barato, sin datos)

`_plan()`: la pregunta + catálogos (personas, estados) → un filtro estructurado JSON.
Corre con `thinking` desactivado (rápido). Devuelve:

```json
{
  "semantica": ["concepto a buscar", "sinónimo", …],   // el modelo EXPANDE sinónimos
  "palabrasClave": ["término literal", …],
  "personas": ["nombre", …],
  "estados": ["clave-estado", …],
  "soloActivas": true,
  "agregados": false
}
```

**Fallback:** si el LLM falla o el JSON es inválido (`_parse_plan`), cae a un plan
amplio (`soloActivas=true`, `agregados=true`) que reproduce el comportamiento previo
(ver todo lo vivo). El reporte nunca se rompe por el planificador.

> La **expansión de sinónimos** la hace este paso (el modelo sabe generar variantes,
> incluida jerga bancaria: "fraude" → AML, lavado, monitoreo transaccional). Por eso
> NO se necesitan embeddings *para los sinónimos* — los embeddings son para relación
> conceptual sin palabras compartidas.

### Paso 2 — Búsqueda híbrida en código (`_build_context`)

Combina **tres señales** y puntúa cada solicitud:

| Señal | Cómo | Aporte al score |
| --- | --- | --- |
| **Semántica** (`_semantic_scores`) | Por cada frase de `semantica`, `search()` en los namespaces `solicitud` (top 20) y `seguimiento` (top 30), `min_score=0.25`. Mapea cada hit a su `projectId` vía `meta`. | Suma de las similitudes coseno (seguimiento ×0.8). |
| **Palabras clave** (literal) | `contains` normalizado (minúsculas, sin acentos) sobre nombre + descripción + textos y autores de seguimientos. | +1.0 por término que aparece. |
| **Personas** (literal) | Igual, contra el nombre del responsable y los autores/textos de seguimientos. | +1.0 por nombre que aparece. |
| **Estados** (filtro duro) | Si `estados` no está vacío, descarta las solicitudes cuyo estado no esté en la lista. | (filtra, no puntúa) |

Luego:

1. **Con señal** (semántica/keyword/persona/estado): solo entran las solicitudes con
   score > 0. **Sin señal** (pregunta amplia) o sin coincidencias: entran todas.
2. **Orden:** por score desc, y a igual score por **última actividad**
   (`_last_activity` = seguimiento/entrega/solicitud más reciente). Así una pregunta
   amplia queda ordenada por lo más movido primero.
3. `soloActivas`: no excluye del todo las cerradas (permite "qué se entregó"); las
   ordena al final (heurística de estados cerrados: `done/delivered/cancelled/…`).
4. **Recorte elegante a presupuesto** (`_CONTEXT_BUDGET_CHARS = 45000`): arma el
   contexto agregando solicitudes por relevancia hasta llenar el presupuesto. Cada
   bloque lleva el detalle + hasta 12 seguimientos (con autor). Si se quedan fuera,
   añade una **nota de alcance**: "se incluyeron las X más relevantes de Y; Z
   quedaron fuera por longitud". El modelo lo reporta en vez de fallar en silencio.
5. **Agregados** (`_aggregates_block`): si `agregados`, antepone conteos
   precalculados (por estado, por área, por mes de entrega) — mucho panorama en
   pocos caracteres, sin volcar cada solicitud. Es lo que responde bien "cómo vamos"
   o tendencias.

**Cota de escala:** sin importar cuántas solicitudes existan, al modelo solo entran
las más relevantes hasta 45K chars; el resto se resume como conteo. El costo por
reporte queda **acotado y constante**, con 50 o con 5,000 solicitudes.

### Paso 3 — Redactor (LLM)

`LlmService().converse` con el contexto acotado + el pedido → reporte markdown + spec
de diagrama (sin cambios respecto al diseño previo; ver `docs/02`). Ahora ve TODOS
los seguimientos de lo relevante (antes 3 por solicitud), así "qué hizo Juan" tiene
la evidencia completa.

### Fallbacks (el reporte nunca se rompe)

- Planificador cae → plan amplio (activas + agregados).
- `_semantic_scores` cae (Titan/índice) → devuelve vacío; la búsqueda sigue con
  literal + estructurado.
- Sin candidatos con señal → todas por recencia.

---

## 7. Qué NO cubre (fronteras conocidas)

| Tipo de pregunta | Estado |
| --- | --- |
| Estado, pendientes, por persona, por área, por fechas, texto literal | ✅ Bien |
| Tendencias / conteos históricos | ✅ Con la rama de agregados |
| Concepto / sinónimos | 🟡 ~95% (sinónimos = planificador; relación conceptual = embeddings) |
| **Varios saltos encadenados** (p. ej. "el responsable con más detenidas, y qué hizo en ellas") | ❌ Territorio del **agente iterativo** con tool-use — el diseño de dos pasos es el primer peldaño hacia eso, no trabajo tirado. |
| Agregaciones históricas arbitrarias fuera de las precalculadas | ❌ Requeriría más ramas de agregados. |

Los embeddings **complementan** al planificador, no lo sustituyen: autor/estado/
fecha son filtro exacto (estructurado); concepto es vector (semántico).

---

## 8. Verificación (2026-07-15)

- Titan invocado real: 256 dims, normalizado.
- Backfill: 42 solicitudes + 80 seguimientos indexados (0 errores); vectores
  confirmados en Dynamo por namespace (`EMBEDDING#solicitud` / `EMBEDDING#seguimiento`).
- Búsqueda semántica E2E: "despliegue de modelos en sagemaker" → #1 la solicitud
  real de Sagemaker (coseno 0.52), seguida de items de infraestructura AWS/Tableau.

---

## 9. Segundo consumidor — Búsqueda avanzada de tablas del Catálogo (2026-07-15)

El mismo `core/embeddings.py`, aplicado al Catálogo Data Lake para que "fecha de
corte" encuentre la tabla cuya columna se llama/describe "cutoff" — el caso que
`docs/02` tenía anotado como pendiente. Demuestra el reuso: es **un namespace más**,
sin infra nueva.

- **DOS NIVELES por cuenta (2026-07-16 — "chunking" por unidad semántica):**
  `catalog:<cuenta>` (un vector por TABLA) y `catalog-col:<cuenta>` (un vector por
  **COLUMNA DOCUMENTADA**, docId `<db>#<tabla>#<col>`). Por qué: con el data lake
  documentándose a fondo, un solo vector por tabla ancha (190+ columnas descritas)
  sería el **promedio de 190 conceptos** — centroide difuso que diluye la señal de
  cada columna (verificado: "codigo de la agencia bancaria" da 0.67 vía el vector de
  la columna `codagencia` vs ~0.39 de los centroides de tabla) — además de rozar el
  límite real de Titan (~8192 tokens). El chunking clásico (partir cada N chars) no
  aplica: la unidad natural del catálogo es la columna, mismo patrón
  seguimiento→solicitud. **Solo columnas con contexto humano** tienen vector (los
  nombres pelones ya van en el vector de tabla): el índice crece con el diccionario.
- **Documento por nivel** (`services/embedding_index.py`): tabla
  (`catalog_table_text`) = nombre + descripción Glue + contexto funcional + nombres
  de columnas con comentario Glue (SIN descripciones humanas de columnas — nivel 2);
  tope 20K chars (margen del límite de tokens) con **warning al 90%** antes de
  truncar. Columna (`catalog_column_text`) = nombre + comentario + descripción +
  notas; texto vacío (sin documentar) = sin vector (el core borra).
- **Indexado on-write best-effort** (`services/catalog.py`), con granularidad para
  no pagar de más: guardar el **contexto de la tabla** re-indexa solo el vector de
  tabla (`include_columns=False` — las columnas no cambian); guardar el **contexto de
  UNA columna** re-indexa solo ESA columna (`safe_index_catalog_column` — en tablas
  de 190 columnas, recorrerlas todas añadiría segundos al guardado; el documento de
  la tabla no cambia porque el nivel 1 no lleva descripciones de columnas);
  `sync_table` re-indexa completo (tabla + columnas); huérfanas del sync → se borra
  el vector de tabla **y los de sus columnas** (nombres tomados del item cacheado
  antes de borrarlo). Idempotente por hash en ambos niveles.
- **Backfill:** acción `catalog_embeddings_backfill` (`aws lambda invoke` con
  `{"action":"catalog_embeddings_backfill","account":"<id>"}`; sin account = hub).
  Paraleliza `get_table`+embed (8 hilos) para caber en el timeout con miles de tablas.
- **Búsqueda (endpoint):** `GET /api/catalog/search?q=&account=` →
  `CatalogService.search_semantic()` → `catalog_search()` busca en **AMBOS niveles**
  y un acierto de columna surface su TABLA (si la misma tabla acierta por los dos,
  gana el mejor score). Es **híbrida**: realza los que además casan literal en
  nombre/base/snippet/columna. Devuelve `[{database, table, snippet, column, score,
  literal}]`; `column` ≠ "" indica que la coincidencia vino de esa columna y la UI
  muestra el chip **"≈ columna: X"**. La ruta literal `/api/catalog/search` se
  registra ANTES de `/{database}` (el router prioriza literales). `min_score` 0.2,
  top_k 40.
- **UX ("Búsqueda avanzada"):** un toggle `≈ Avanzada` junto al buscador
  (`catalog.ts`). Apagado = búsqueda instantánea actual (keyword, dentro de la base
  seleccionada, filtra **en vivo** cada letra) sin cambios. Encendido = consulta
  semántica **por envío explícito** — se escribe la idea completa y se busca con
  **Enter** o el botón **«Buscar»** (aparece un botón junto al input); NO busca en
  cada tecla. Motivo (feedback del usuario): la semántica se escribe como una frase/
  idea, y buscar con frases a medias hacía saltar resultados irrelevantes y confundía
  (distinto del keyword, donde teclear en vivo sí acota). Resultado: lista plana
  ranqueada a **toda la cuenta**, badge "≈ significado"/"coincidencia"; al hacer clic
  navega a esa base + abre la tabla. Vaciar el campo limpia resultados; el índice es
  por cuenta (cambiar de cuenta limpia resultados).
- **Optimización compartida:** `_hub_session()` cachea la sesión STS del hub entre
  invocaciones calientes (antes: un assume-role por vector) — hace viable el backfill
  de cientos/miles de tablas. Beneficia también a Solicitudes.
- **Sesgo de cuenta:** solo se indexa la cuenta que se sincroniza/edita/backfillea.
  El backfill corrió sobre el **hub (prod)**, la cuenta real; las demás (réplicas de
  prueba) se llenan si se usan.

**Fronteras (dichas al usuario):** semántica pura (no cubre preguntas encadenadas de
varios saltos); una tabla sin descripción/columnas documentadas rinde menos (su
diccionario semántico es pobre) — se enriquece agregando contexto. La vía **keyword**
exacta (modo normal) sigue disponible para búsquedas literales.

---

## 10. Verificación del Catálogo (2026-07-15/16)

- Backfill del hub: **603 tablas** en `catalog:396913696127` + **204 columnas
  documentadas** en `catalog-col:396913696127` (0 errores, todas las bases; 31 s).
- E2E nivel 1: "fecha de corte" → #1-3 las tablas `*_fecha_corte` reales de
  `ds_sandbox` (0.49), cruzando bases; "informacion de clientes y cuentas" →
  `info_clientes`, `apertura_cuentas`, `cuentas`, `clientes` (0.60+).
- E2E nivel 2 (la tesis de la dilución, confirmada): "codigo de la agencia
  bancaria" → **0.67 vía la columna `codagencia`** de `cn_cap_ahorro_resumen`
  (los centroides de tabla daban ~0.39); "monto o importe de la transaccion" →
  columnas `monto_*` reales de las tablas de detalle.
- **Incidente de rendimiento (2026-07-16, resuelto):** el primer backfill de dos
  niveles agotó los 600 s del Lambda — `DynamoVectorStore._table()` y
  `TitanEmbedder._client()` creaban una sesión/cliente boto3 NUEVO por operación
  (~100-200 ms c/u × ~12K operaciones de columnas). Arreglo en el core: **caché de
  clientes a nivel de módulo** (`_CLIENT_CACHE`, llave por sesión — los clientes
  boto3 son thread-safe y los comparten los workers). Resultado: 603 tablas + 204
  columnas en **31 s**. Lección para consumidores del core: los clientes se cachean
  solos; no crear sesiones por llamada en los providers (el del hub ya venía
  cacheado por expiración).

---

## 11. Tercer consumidor — Búsqueda avanzada de Solicitudes (2026-07-15)

Mismo `core/embeddings.py`, aplicado al buscador del módulo Solicitudes. **No indexa
nada nuevo**: reutiliza los vectores `solicitud` + `seguimiento` que ya existían (del
Reporte ejecutivo, frescos por on-write). Distinto del Catálogo: allí el valor era
"todas las bases a la vez"; aquí todas las solicitudes ya están en memoria y el keyword
es instantáneo, así que el valor es (a) **por concepto** y (b) **por el contenido de los
seguimientos**, que el keyword de la lista **no busca** (solo nombre + descripción + área
+ responsable + miembros; ver `getVisibleProjects`/`projectSearchText`).

- **Endpoint:** `GET /api/workspace/search?q=` → `WorkspaceService.search_advanced()`.
  Desde 2026-07-15 usa el **planificador** (§12): la consulta pasa por
  `plan_query()` con los campos declarados del módulo (estado, responsable, área,
  tipo) → `{filtros exactos, concepto semántico, interpretación}`. El concepto (si lo
  hay) se ranquea con `workspace_semantic_search()` — **híbrida sobre DOS namespaces**
  (`solicitud` + `seguimiento`), mapeando cada acierto a su solicitud padre. Devuelve
  `{query, interpretation, filters, semantic, results:[{projectId, score, via, updateId}]}`.
  `min_score` 0.2. Sin colisión de ruta: `/api/workspace/search` (3 segmentos) ≠
  `/api/workspace` (2).
- **UX ("≈ Avanzada"):** toggle junto al buscador (`workspace.ts`), **por envío explícito**
  (Enter/«Buscar»), idéntico al Catálogo. Apagado = keyword en vivo (sin cambios).
- **Presentación (decisión del usuario): reordenar la tabla existente**, NO una lista
  aparte. El frontend aplica los **filtros exactos del planificador** (`projectSemFilters`:
  responsable/estado/área/tipo) en `getVisibleProjects`, **combinándolos con los filtros
  manuales** (chips/dropdowns); si hay concepto semántico, además filtra a las coincidencias
  y **reordena por relevancia** (`sortProjectsForTable` usa el score). Consulta de PURO
  filtro (sin concepto, p. ej. "responsable Diego") → muestra TODAS las que cumplen, sin
  ranking. Se conservan columnas, filtros y el detalle al hacer clic. Las filas que
  coincidieron por un seguimiento muestran un chip **"≈ seguimiento"** con el fragmento.
  Un banner **"Entendí: …"** (`interpretationBanner`) muestra qué extrajo el planificador,
  para que el usuario sepa por qué se filtró/ordenó así.
- **Envío discreto → render completo:** como es por envío (no por tecla), `runProjectSemanticSearch`
  hace un `renderWorkspace()` completo sin el problema de foco del keyword (ese sí filtra
  sin re-render, `applyProjectSearch`; ver §incidente en `docs/22` y regla en `docs/06`).

**Verificación E2E (2026-07-15):** "integracion de datos de redes sociales" → #1 la
solicitud "Data redes sociales APi" (0.65); "se revisaron las apis y las necesidades" →
#1 el seguimiento real del 15-jul (0.92) de esa misma solicitud — es decir, buscar por el
**contenido de un seguimiento** encuentra su solicitud, algo imposible con el keyword.

---

## 12. Planificador de consultas — `core/query_planner.py` (2do core genérico)

**Por qué:** la búsqueda semántica pura NO filtra por atributos exactos. "solicitudes
donde el responsable sea Diego" embebe como un tema, y como todas las solicitudes son
temáticamente parecidas, casi todas superan el umbral → devolvía 34 de 43, sin filtrar
por Diego (bug reportado por el usuario). El planificador separa lo **exacto** de lo
**conceptual**, como el del Reporte ejecutivo, pero **generalizado y reutilizable**.

**Genérico (el "cerebro"):** `plan_query(query, fields, complete_fn) -> QueryPlan`.
Cero imports del proyecto; el LLM se inyecta como callable `complete(prompt, system)`.
Devuelve `{filters: {campo: id}, semantic: str, interpretation: str}`. El prompt lista
los campos y, para los enumerables, sus valores como `id=label` — el LLM devuelve el
`id` (resuelve parciales: "Diego" → id de "Diego Sosa"). Parseo defensivo: descarta
campos no declarados e ids fuera de los valores. **Fallback:** ante cualquier fallo,
degrada a "todo semántico" (`semantic = query`, sin filtros) → la búsqueda no se rompe.

**Por módulo (los "campos", específicos por definición):** cada consumidor declara sus
`FilterField(key, label, description, values=[{id,label}]|None)`. Solicitudes declara
estado/responsable/área/tipo (`WorkspaceService.search_advanced`). Es SOLO declarar una
lista — la lógica de planificación es compartida. **Reuso en Catálogo:** listo para
enchufarse declarando sus campos (p. ej. `database`, `tableType`); "tablas de data_mart
sobre clientes" → filtro `database=data_mart` + concepto "clientes". Cuando se mejore
`query_planner`, mejora para todos los consumidores.

**Verificado E2E contra GLM real (2026-07-15):**
- "solicitudes donde el responsable sea diego" → `{ownerPersonId: Diego Sosa}`, semantica="" (puro filtro).
- "lo que se habló de las apis" → `{}`, semantica="apis" (puro concepto).
- "solicitudes activas de diego sobre tableau" → `{status: active, ownerPersonId: Diego Sosa}`, semantica="tableau" (mixto).
- "requerimientos en desarrollo" → `{requestType: requirement, status: En Desarrollo}` (resuelve etiqueta→id, puro filtro).

## 13. Cuarto consumidor — Wiki: chunking clásico + RAG «Preguntar a la Wiki» (2026-07-23)

La Wiki es el primer consumidor con **chunking clásico por tramos** (a diferencia del
catálogo, donde el chunk es una unidad semántica — la columna): el contenido es prosa
libre y los PDFs adjuntos pueden ser largos, así que se trocea con `chunk_text()`
(`services/embedding_index.py`): tramos de **~2 000 chars con solape de 200**, cortando
en salto de línea/espacio cercano al límite para no partir ideas.

**Dos namespaces (mismo patrón parent-document):**

| Namespace | Contenido | docId |
| --- | --- | --- |
| `wiki` | 1 vector por página: título + inicio del cuerpo (≤6 000 chars) | `<pageId>` |
| `wiki-doc` | chunks del cuerpo cuando supera 6 000 chars y del **texto extraído de cada PDF** | `<pageId>#body#<n>` / `<pageId>#<token>#<n>` |

Particularidades:

- **El chunk guarda su TEXTO en `meta.text`** (≤2 000 chars → item ~3 KB): el RAG arma
  el contexto directo de los hits, sin releer S3 ni recalcular offsets.
- **Reconciliación**: al reindexar una página se calculan los chunks deseados y se
  borran los existentes con prefijo `<pageId>#` que sobran (PDF quitado, cuerpo
  acortado). Usa `EmbeddingIndex.list_ids()` (nuevo en el core, proyección mínima).
- **Texto de PDFs**: viene del sidecar `wiki/doc/<token>.txt` que escribe
  `process_document` (pypdf) al confirmar la subida — ver `docs/02` Wiki.
- Hooks on-write en `WikiService` (crear/editar → `safe_index_wiki_page`; borrar →
  `safe_delete_wiki_page`); backfill one-shot `{"action":"wiki_embeddings_backfill"}`.

**RAG (`WikiService.ask`, `POST /api/wiki/ask`, guard de lectura):** `wiki_search()`
busca en ambos namespaces (top 12, min_score 0.22, sin colapsar duplicados de página —
varios tramos relevantes de la misma página son bienvenidos) → contexto con presupuesto
de 30K chars (hit de página completa ≤8K; hit de chunk usa su `meta.text`) → GLM
(thinking off, 1 200 tokens) con system prompt que lo limita al contexto y le exige
citar páginas → respuesta + `sources` (pageId/título/via) que el frontend pinta como
chips clicables. Sin hits, responde honesto sin invocar al LLM. **Alcance opcional**
(check «Solo esta página», 2026-07-23): `pageId` en el payload filtra los hits a esa
página y sus PDFs; sin hits dentro de ella, el cuerpo de la página entra igual al
contexto (acotar a propósito nunca devuelve vacío).

**Verificación (2026-07-23, AWS real):** backfill 1 página → 1 vector `wiki` + 9 chunks
`wiki-doc`; PDF de prueba subido por presign + `process` extrajo su texto exacto al
sidecar (`extractable: true, pages: 1`); `/api/wiki/ask` ("¿de qué trata la wiki?")
respondió citando la página "Estándar de Nomenclatura — Data Lake AWS".

Ver también: `docs/01` (arquitectura), `docs/02` (Reporte ejecutivo + Catálogo + Solicitudes + Wiki),
`docs/04` (ítem EMBEDDING), `docs/07` (Catálogo), `docs/permisos_hub.md` 1d (ARN Titan),
`docs/22` (bitácora).
