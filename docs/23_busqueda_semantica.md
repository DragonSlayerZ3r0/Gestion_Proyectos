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
services/exec_report.py       CONSUMIDOR — búsqueda de dos pasos del reporte
```

**Regla de reuso:** `core/embeddings.py` no conoce solicitudes, hubs ni dominios —
solo `(docId, texto, meta)`. Se copia tal cual a plataformas hermanas
(Plataforma_Inteligencia, Agente_Mantenimiento). Un módulo nuevo con búsqueda
semántica es otra instancia de `EmbeddingIndex` con su propio `namespace`.

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
- **Namespaces:** `solicitud` (nombre + descripción; `docId = projectId`) y
  `seguimiento` (texto de la bitácora; `docId = updateId`).
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

Ver también: `docs/01` (arquitectura), `docs/02` (Reporte ejecutivo), `docs/04`
(ítem EMBEDDING), `docs/permisos_hub.md` 1d (ARN Titan), `docs/22` (bitácora).
