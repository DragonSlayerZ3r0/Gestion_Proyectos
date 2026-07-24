# Modelo DynamoDB

## Tabla principal recomendada

Usar una tabla operacional única inicialmente, con claves genéricas:

```text
PK
SK
entityType
createdAt
updatedAt
createdBy
updatedBy
```

Nombre sugerido:

```text
gestion-proyectos-main-{env}
```

## Entidades

- `USER`
- `USER_MODULE`
- `PERSON`
- `PROJECT`
- `PROJECT_USER`
- `PROJECT_TABLE`
- `PROJECT_MEMBER`
- `PROJECT_UPDATE`
- `PERSON_ABSENCE`
- `HOLIDAY`
- `ATTACHMENT`
- `TASK`
- `AREA`
- `PROJECT_STATUS`
- `DRAWING`
- `DRAWING_SHARE`
- `TABLE_CONTEXT`
- `COLUMN_CONTEXT`
- `DASHBOARD`
- `REQUEST`
- `COMMENT`
- `AUDIT_EVENT`
- `SETTING`
- `EMBEDDING#<namespace>` (vectores de búsqueda semántica, 2026-07-15 — ver `docs/23`)
- `WIKI_PAGE` / `WIKI_REV` (Wiki, 2026-07-22)

## Ejemplos de claves

```text
USER
PK = USER#<userId>
SK = PROFILE

USER_MODULE
PK = USER#<userId>
SK = MODULE#<moduleKey>

PERSON (el perfil guarda también los atributos de la vista Personal:
  vacationDays={"2026": 20} —cuota anual— y staffNotes —nota exclusiva de esa vista—)
PK = PERSON#<personId>
SK = PROFILE

AREA (catálogo vivo de áreas, COMPARTIDO por "Área solicitante" y "Grupo de trabajo" (antes "Área destino");
  las solicitudes guardan requestingAreaId y targetAreaId. Borrado protegido si
  alguna solicitud la usa en cualquiera de los dos campos)
PK = AREA#<areaId>
SK = PROFILE

PROJECT_STATUS (estado de solicitud — catálogo vivo: label + color de paleta + order.
  Los 4 semilla usan sus claves como id — planned/active/paused/closed — para que las
  solicitudes ya guardadas calcen sin migración; las solicitudes guardan status = statusId)
PK = STATUS#<statusId>
SK = PROFILE

PROJECT
PK = PROJECT#<projectId>
SK = META

PROJECT_USER
PK = PROJECT#<projectId>
SK = USER#<userId>

PROJECT_MEMBER
PK = PROJECT#<projectId>
SK = PERSON#<personId>

TASK
PK = PROJECT#<projectId>
SK = TASK#<taskId>

PROJECT_UPDATE (seguimiento/bitácora de la solicitud: date + text + autor)
PK = PROJECT#<projectId>
SK = UPDATE#<updateId>

HOLIDAY (asuetos autorizados 2026-07-09: date + name + half + notes; upsert por
  fecha. Los completos no descuentan del saldo de vacaciones)
PK = HOLIDAY#<AAAA-MM-DD>
SK = PROFILE

PERSON_ABSENCE (Personal 2026-07-08: ausencia tipada de una persona — type
  vacation|leave|sick + startDate/endDate + notes; sin traslapes por persona.
  El saldo de vacaciones vive en el perfil PERSON como vacationDays={"2026":20};
  consumido = días hábiles L-V de las ausencias vacation. Escritura solo admin)
PK = PERSON#<personId>
SK = ABSENCE#<absenceId>

ATTACHMENT (adjuntos de la solicitud, 2026-07-07. kind=file → binario en S3
  (storageKey en el bucket compartido gad-storage-<env>, prefijo de la app) con
  metadata aquí; kind=query → texto inline (title + text), SIN S3. updateId
  opcional = relación con una entrada de seguimiento ("" = General). Al borrar
  la solicitud o el adjunto se borra también el objeto S3)
PK = PROJECT#<projectId>
SK = ATTACH#<attachmentId>

DRAWING (pizarra Excalidraw, 2026-07-07: name + ownerUserId + storageKey de la
  escena .excalidraw en S3 bajo drawings/. Sin compartir, solo el dueño la ve)
PK = DRAWING#<drawingId>
SK = META

DRAWING_SHARE (invitación por usuario: status pending → el invitado acepta
  (accepted, ve/edita) o rechaza (se borra el item). Solo el dueño invita/revoca)
PK = DRAWING#<drawingId>
SK = SHARE#<email>

WIKI_PAGE (página de la Wiki, 2026-07-22: title + body markdown ≤150K chars +
  autoría + revisionCount. Lectura = módulo wiki; escritura = sub-permiso
  wiki_editor. Título único sin acentos/mayúsculas)
PK = WIKI#<pageId>
SK = META

WIKI_REV (revisión append-only: snapshot del estado ANTERIOR a cada edición —
  title + body + savedAt/By. Se borran junto con la página; el SK ordena
  cronológicamente natural)
PK = WIKI#<pageId>
SK = REV#<updatedAt-anterior>#<uuid8>

EMBEDDING (vector de búsqueda semántica, 2026-07-15. UN item por documento
  vectorizado; namespaces actuales: solicitud (nombre+descripción, docId=projectId),
  seguimiento (texto, docId=updateId), catalog:<cuenta> (tabla del catálogo,
  docId=<db>#<tabla>), catalog-col:<cuenta> (COLUMNA DOCUMENTADA del catálogo,
  docId=<db>#<tabla>#<col> — nivel 2 del "chunking" por unidad semántica,
  2026-07-16), wiki (1 vector por página, docId=pageId, 2026-07-23) y wiki-doc
  (chunks de ~2000 chars con solape: cuerpo largo docId=<pageId>#body#<n> y
  texto extraído de PDFs adjuntos docId=<pageId>#<token>#<n>; el chunk guarda su
  TEXTO en meta para que el RAG arme el contexto sin releer S3).
  Atributos: vec=Binary (float32 empacado, 256 dims = 1 KB), dim,
  srcHash (huella del texto → idempotencia: no re-embebe si no cambió), meta (map
  con projectId/date/author o database/table/column/snippet), updatedAt. entityType
  lleva el namespace para que el GSI devuelva SOLO ese segmento en una query.
  Genérico y parametrizable — core/embeddings.py; mecánica completa en docs/23)
PK = EMBED#<namespace>#<docId>
SK = EMBED#<namespace>

DRAW_CONNECTION (colaboración en vivo 2026-07-08: conexiones WebSocket de la
  sala de un tablero. DOS items por conexión — miembro de sala para el fan-out
  y reverso para resolver la sala desde un connectionId ($disconnect/mensajes
  solo traen el connectionId). Expiran solas con ttl (12 h) si escapan del
  $disconnect)
PK = DRAWROOM#<drawingId>   SK = CONN#<connectionId>
PK = DRAWCONN#<connectionId> SK = META

TABLE_CONTEXT (2026-07-15: llaves con cuenta AWS — varias cuentas replican el
  hub con bases homónimas; también aplica a COLUMN_CONTEXT, TABLE_USAGE y toda
  la caché CATALOG_*. La documentación pre-multicuenta se migró al namespace
  del hub 396913696127)
PK = TABLE#<accountId>#<database>#<table>
SK = CONTEXT

COLUMN_CONTEXT
PK = TABLE#<accountId>#<database>#<table>
SK = COLUMN#<columnName>

AUDIT_EVENT
PK = AUDIT#<date>
SK = <timestamp>#<eventId>

CATALOG_DB (caché de Glue)
PK = CATALOG#<accountId>#DB
SK = <database>

CATALOG_TABLE (caché de Glue, incluye columnas y glueUpdatedAt)
PK = CATALOG#<accountId>#<database>
SK = TABLE#<table>

CATALOG_SYNC (estado del sync global, un item por cuenta)
PK = CATALOG#SYNC
SK = META#<accountId>

HOME_COSTS (caché de costos AWS por cuenta y periodo)
PK = HOME#COSTS
SK = <accountId>#<inicio>#<fin>

DATALAKE_INGEST (caché del monitoreo de cargas del data lake)
PK = DATALAKE#INGEST
SK = <bucket>                  # overview: por zona y por día + estado/scannedAt
SK = <bucket>#detail#<zona>    # detalle por área (byArea → byDay)
SK = <bucket>#records#<zona>#<inicio>#<fin>   # registros (filas parquet) por área→tabla y área→día, cacheado por rango
SK = <bucket>#recdaytbl#<zona>#<area>#<dia>   # tablas de un (área, día) bajo demanda (drill Por fecha)
```

```text
HOME_ATHENA (caché del monitoreo de consumo de Athena por usuario)
PK = HOME#ATHENA
SK = <inicio>#<fin>            # agregado por usuario + top consultas + estado/scannedAt (TTL 8h)
```

Los items `CATALOG_*` son caché de metadata técnica: el sync diferencial los escribe o elimina comparando `glueUpdatedAt` contra el `UpdateTime` de Glue. `TABLE_CONTEXT` y `COLUMN_CONTEXT` pertenecen al contenido funcional escrito por usuarios y mantienen un ciclo de vida independiente, incluso cuando la tabla desaparece de Glue.

`CATALOG_DB` incluye además `stats` (tamaño/objetos/frescura S3 agregados de la base, calculados en el sync). `HOME_COSTS` cachea el resultado de Cost Explorer con `fetchedAt`; TTL diferenciado (mes en curso 8 h, meses cerrados 30 días) y las cifras viajan como string (DynamoDB no acepta float). `DATALAKE_INGEST` cachea el histograma de cargas por día (archivos/bytes por zona y área) que el escaneo asíncrono escribe listando S3; `scannedAt` + `status` para frescura (TTL 12 h) y polling. Los items `#records#` cachean el conteo de **filas** (de la tabla de control de ingesta `stage_staging.ctl_ingestion_unstructured` consultada vía **Athena** asumiendo el rol del hub) por área→tabla y área→día, **acotado a un rango** (`#<inicio>#<fin>`) y calculado async con el mismo patrón de `status`/poll. Ver `docs/02_modulos_funcionales.md`.

## Patrones de consulta

- Obtener perfil de usuario por `USER#<userId>`.
- Obtener módulos habilitados por usuario.
- Listar proyectos donde participa un usuario mediante índice si es necesario.
- Listar tareas por proyecto.
- Obtener contexto funcional de una tabla.
- Obtener contexto de columnas de una tabla.
- Consultar auditoría por fecha.

## Edición operativa

El panel de detalle actualiza los mismos registros operativos:

- `PERSON`: nombre, apellido, nombre completo, área, notas, disponibilidad y estado.
- `PROJECT`: nombre, descripción, estado opcional y responsable opcional.
- `PROJECT_MEMBER`: rol funcional dentro del proyecto.
- `TASK`: título, estado, prioridad opcional, responsable opcional y notas.

Los cambios de tarea en estado, prioridad o responsable generan `AUDIT_EVENT` con `changedFields`.

## Índices

**GSI `byEntityType`** (2026-07-03, en uso): partition `entityType`, sort `PK`, proyección ALL. Es el índice de los **listados globales** — personas, proyectos, membresías de una persona, tareas (conteo del Panel) y usuarios/módulos de Administración consultan SOLO sus items en vez de escanear la tabla completa (con los items `ATHENA#EXEC` del monitoreo, un scan filtrado leía megas para devolver kilobytes). Acceso vía `BaseRepository._query_entity_type(tipo, filtro_extra)` con **fallback automático al scan paginado** si el índice no está ACTIVO (backfill tras crearlo, o stack recién creado) — así el orden de despliegue nunca rompe la vista.

La **búsqueda semántica** también se apoya en este GSI: como `entityType` es `EMBEDDING#<namespace>`, una sola query trae TODOS los vectores de ese namespace (y solo esos) con su vector completo (proyección ALL); el coseno se calcula en la Lambda. `DynamoVectorStore` no hereda de `BaseRepository` (el módulo `core/embeddings.py` es autocontenido a propósito) pero **respeta la regla de paginación** con su propio loop de `LastEvaluatedKey`. Detalle en `docs/23`.

## Índices potenciales

Agregar índices solo cuando el patrón de consulta lo requiera:

- GSI para proyectos por usuario.
- GSI para tareas por responsable.
- GSI para tareas por estado.
- GSI para auditoría por entidad afectada.

## Regla obligatoria: lecturas SIEMPRE paginadas

DynamoDB devuelve **máximo 1 MB por página** en `query` y `scan` — y en `scan`, el límite aplica **antes** de evaluar el filtro. Una lectura de una sola página "funciona" mientras la tabla es chica y un día empieza a devolver **datos incompletos sin ningún error** (incidente 2026-07-03: el módulo Proyectos se "vació" cuando los items `ATHENA#EXEC` del monitoreo llenaron las primeras páginas del scan; los datos estaban intactos).

Por eso:

- Ningún repositorio llama `self._table.query(...)` ni `self._table.scan(...)` directo. **Siempre** `self._query_all(...)` / `self._scan_all(...)` de `BaseRepository` (pagina con `LastEvaluatedKey` hasta el final; aceptan los mismos kwargs).
- La regla se **verifica automáticamente**: `scripts/check-dynamo-pagination.sh` (parte de `npm run check`) falla si aparece un query/scan crudo fuera de `base.py`.
- Aplica también a los flujos de **borrado** (borrar los hijos de un proyecto/usuario): un borrado sobre una página incompleta deja huérfanos silenciosos.
- Los `scan` con filtro siguen siendo un antipatrón de costo a escala (leen toda la tabla); si un listado escaneado se siente lento, la mejora es un GSI/Query — pero paginar es lo mínimo no negociable.
