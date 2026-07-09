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

DRAW_CONNECTION (colaboración en vivo 2026-07-08: conexiones WebSocket de la
  sala de un tablero. DOS items por conexión — miembro de sala para el fan-out
  y reverso para resolver la sala desde un connectionId ($disconnect/mensajes
  solo traen el connectionId). Expiran solas con ttl (12 h) si escapan del
  $disconnect)
PK = DRAWROOM#<drawingId>   SK = CONN#<connectionId>
PK = DRAWCONN#<connectionId> SK = META

TABLE_CONTEXT
PK = TABLE#<database>#<table>
SK = CONTEXT

COLUMN_CONTEXT
PK = TABLE#<database>#<table>
SK = COLUMN#<columnName>

AUDIT_EVENT
PK = AUDIT#<date>
SK = <timestamp>#<eventId>

CATALOG_DB (caché de Glue)
PK = CATALOG#DB
SK = <database>

CATALOG_TABLE (caché de Glue, incluye columnas y glueUpdatedAt)
PK = CATALOG#<database>
SK = TABLE#<table>

CATALOG_SYNC (estado del sync global)
PK = CATALOG#SYNC
SK = META

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
