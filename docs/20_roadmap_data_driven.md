# Roadmap data-driven (mediano plazo)

> Estado: **propuesta de diseño, no implementado.** Documenta hacia dónde crece el
> catálogo para subir de "descubrimiento" a "datos confiables y entendibles".
> Ver `docs/07_catalogo_datalake.md` para lo ya implementado y
> `docs/14_permisos_aws_actuales.md` para la restricción de Bedrock/Claude.

## Principio rector

Reutilizar la separación que ya existe en `CatalogService`:

- **Caché propiedad del sync** (`CATALOG_*`): metadata técnica, refrescable, el sync
  escribe y elimina huérfanos comparando `glueUpdatedAt`.
- **Contenido propiedad del usuario** (`*_CONTEXT`): contenido funcional escrito por
  personas, el sync nunca lo toca aunque la tabla desaparezca de Glue.

Cada capa nueva se clasifica en una de las dos. Esto mantiene el patrón actual y evita
inventar mecánica nueva.

## Capa de confianza — linaje

Responde "¿de dónde sale esta tabla y a qué alimenta?". Dos orígenes, espejo de la
separación caché/contenido:

- **Observado** (caché del sync): derivado del SQL de las vistas. Glue ya entrega
  `ViewOriginalText` en las tablas `VIRTUAL_VIEW`; parsear las tablas referenciadas da
  aristas upstream sin infraestructura nueva. Refrescable en cada sync.
- **Declarado** (contenido del usuario): aristas que una persona declara a mano
  (p. ej. "esta tabla alimenta el dashboard X"). El sync nunca las borra.

Entidad `LINEAGE_EDGE`. Se escriben las dos direcciones denormalizadas para consultar
los vecinos de una tabla con un solo `begins_with(SK, "LINEAGE#")`, sin GSI:

```text
LINEAGE_EDGE (upstream de esta tabla)
PK = TABLE#<db>#<table>
SK = LINEAGE#UP#<upDb>#<upTable>

LINEAGE_EDGE (downstream de esta tabla)
PK = TABLE#<db>#<table>
SK = LINEAGE#DOWN#<downDb>#<downTable>

Atributos: origin (observed | declared), sourceType (view_sql | glue_job | manual),
           lastObservedAt, updatedBy (solo declared)
```

Al escribir A→B se escriben dos items: B con `UP#A` y A con `DOWN#B`.

## Capa de confianza — calidad

Responde "¿está fresca, completa, sana?". Separar en dos señales por costo:

- **Frescura (barata, en el sync actual):** se calcula de la última partición o de
  `glueUpdatedAt` durante el sync de metadata que ya corre. Cero costo extra. Se puede
  enviar hoy.
- **Reglas (Glue Data Quality, cadencia aparte):** nulos, rangos, unicidad vía DQDL.
  La *evaluación* corre como job de Glue DQ (consume DPU), por eso va en cadencia
  programada (EventBridge → `StartDataQualityRulesetEvaluationRun`), no en cada sync.
  El catálogo solo **lee** el último resultado y lo cachea.

Entidad `QUALITY_RESULT` (caché del sync):

```text
QUALITY_RESULT (último resultado por tabla)
PK = TABLE#<db>#<table>
SK = QUALITY#LATEST

Atributos: status (green|amber|red), score, rulesPassed, rulesFailed,
           freshnessAt, evaluatedAt, failedRules[]

Histórico opcional para tendencia:
SK = QUALITY#<timestamp>
```

El sync de calidad lee resultados con `glue.list_data_quality_results` /
`get_data_quality_result` y escribe `QUALITY_RESULT`. Las evaluaciones son externas.

## Capa semántica — métricas

Responde "¿qué es un cliente activo? ¿qué es saldo en mora?". Definición única,
certificada, propiedad del usuario (el sync nunca la toca). Entidad `METRIC_DEF`:

```text
METRIC_DEF (definición de métrica de negocio)
PK = METRIC#<metricId>
SK = DEF

Atributos: name, description, expression (humana + SQL opcional), domain,
           owner, status (draft|certified), updatedBy

Enlace métrica → tabla (ambas direcciones):
PK = METRIC#<metricId>   SK = TABLE#<db>#<table>
PK = TABLE#<db>#<table>  SK = METRIC#<metricId>
```

Desde el detalle de tabla se listan las métricas que dependen de ella; desde una
métrica, sus tablas fuente. El asistente RAG puede responder "¿cómo se define X?"
leyendo `METRIC_DEF`.

## Enganche al sync existente

| Cadencia | Qué hace | Costo | Dónde |
| --- | --- | --- | --- |
| Sync de metadata | actual, sin cambios; + frescura barata | bajo, frecuente | `_sync_database_tables` |
| Linaje observado | parsea `ViewOriginalText` y escribe aristas | bajo | nuevo paso en el sync |
| Sync de calidad | lee últimos resultados de Glue DQ → `QUALITY_RESULT` | bajo (solo lectura) | método nuevo, cadencia aparte |
| Evaluación DQ | corre el job de reglas | DPU, programado | EventBridge, fuera del catálogo |

## Impacto en el asistente RAG

El "documento" que se embebe por tabla debería incluir, además del contexto funcional:
las métricas que la usan, su estado de calidad y su linaje resumido. Así el asistente
responde no solo "dónde está el dato" sino "qué tan confiable es y de dónde viene".
Re-embeber al cambiar `TABLE_CONTEXT`, `METRIC_DEF` o `QUALITY_RESULT`.

## Secuenciación sugerida

1. Frescura en el sync actual (barato, valor inmediato de confianza).
2. Linaje observado desde SQL de vistas (sin infra nueva).
3. `METRIC_DEF` + enlaces (capa semántica).
4. Glue Data Quality con reglas + evaluación programada.
5. Enriquecer el documento de embeddings con las tres señales.

La capa de acción/ontología (write-back, apps operacionales) queda **fuera** de este
roadmap: es una decisión de alcance posterior y deliberada, no continuación natural.
