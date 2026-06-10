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

## Información guardada en DynamoDB

- Descripción funcional de tabla.
- Responsable funcional.
- Proyecto asociado.
- Nivel de sensibilidad.
- Reglas de uso.
- Descripción funcional de columnas.
- Notas internas.
- Estado de documentación.

## Relación tabla-proyecto

Una tabla puede asociarse a uno o varios proyectos mediante `PROJECT_TABLE`.

Esto permite mostrar qué datos usa cada proyecto y controlar visibilidad funcional.

## Preview con Athena

Athena solo debe usarse para consultas controladas:

- Límite de filas.
- Columnas permitidas.
- Sin SQL libre desde frontend.
- Validación previa de permisos.
- Registro de auditoría cuando aplique.

## Visibilidad

No todos los usuarios deben ver todo el catálogo. La visibilidad debe depender de permisos por módulo, proyecto, tabla o regla funcional definida.

## Estado implementado

### Backend

- `backend/app/repositories/glue.py`: `GlueRepository` lee bases, tablas y detalle de tabla con `boto3.client("glue")` sobre el catálogo de la cuenta local.
- `backend/app/services/catalog.py`: `CatalogService` con `list_databases`, `list_tables`, `get_table`, `sync_table`, `sync_database`, `start_sync_all`, `run_sync_all`, `save_table_context` y `save_column_context`.
- La metadata sincronizada se guarda como cache en DynamoDB (`MainTableRepository.put_catalog_database/put_catalog_table/put_catalog_sync_meta`); el frontend lee desde el cache, no desde Glue en línea.
- El sync global es asíncrono: `POST /api/catalog/sync` auto-invoca la Lambda con `InvocationType=Event` y payload `{"action": "catalog_sync_all"}`. No hay regla de EventBridge; `handler.py` acepta `source == "aws.events"` como entrada futura.

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

Todas requieren el módulo `catalog` habilitado para el usuario.

### Frontend

- Búsqueda del catálogo con filtros de alcance: bases, tablas y columnas.
- Detalle de tabla con columnas, tipos y contexto funcional editable.
- Grafo de relaciones con D3.js: relaciones entre tablas por columnas compartidas, carga de columnas bajo demanda al seleccionar una tabla, y exclusión de columnas de partición para no generar relaciones falsas.

### Visibilidad pendiente (Lake Formation)

La Lambda solo ve las bases locales en modo legado `IAM_ALLOWED_PRINCIPALS`. Para ver todas las bases del data lake hub (cuenta `396913696127`) está pendiente: grants `DESCRIBE` del lado hub hacia la cuenta consumidora, resource links por CDK en la cuenta local, y grants `DESCRIBE` sobre los links únicamente al rol de la Lambda. Ver `docs/15_estado_implementacion.md`.
