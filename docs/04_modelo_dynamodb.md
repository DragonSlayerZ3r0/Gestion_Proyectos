# Modelo DynamoDB

## Tabla principal recomendada

Usar una tabla operacional unica inicialmente, con claves genericas:

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
- `PROJECT`
- `PROJECT_USER`
- `PROJECT_TABLE`
- `TASK`
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

PROJECT
PK = PROJECT#<projectId>
SK = META

PROJECT_USER
PK = PROJECT#<projectId>
SK = USER#<userId>

TASK
PK = PROJECT#<projectId>
SK = TASK#<taskId>

TABLE_CONTEXT
PK = TABLE#<database>#<table>
SK = CONTEXT

COLUMN_CONTEXT
PK = TABLE#<database>#<table>
SK = COLUMN#<columnName>

AUDIT_EVENT
PK = AUDIT#<date>
SK = <timestamp>#<eventId>
```

## Patrones de consulta

- Obtener perfil de usuario por `USER#<userId>`.
- Obtener modulos habilitados por usuario.
- Listar proyectos donde participa un usuario mediante indice si es necesario.
- Listar tareas por proyecto.
- Obtener contexto funcional de una tabla.
- Obtener contexto de columnas de una tabla.
- Consultar auditoria por fecha.

## Indices potenciales

Agregar indices solo cuando el patron de consulta lo requiera:

- GSI para proyectos por usuario.
- GSI para tareas por responsable.
- GSI para tareas por estado.
- GSI para auditoria por entidad afectada.
