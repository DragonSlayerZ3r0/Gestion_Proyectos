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

PERSON
PK = PERSON#<personId>
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
- Obtener módulos habilitados por usuario.
- Listar proyectos donde participa un usuario mediante índice si es necesario.
- Listar tareas por proyecto.
- Obtener contexto funcional de una tabla.
- Obtener contexto de columnas de una tabla.
- Consultar auditoría por fecha.

## Edición operativa

El panel de detalle actualiza los mismos registros operativos:

- `PERSON`: nombre, apellido, nombre completo, área, notas, disponibilidad y estado.
- `PROJECT`: nombre, descripción, estado y responsable.
- `PROJECT_MEMBER`: rol funcional dentro del proyecto.
- `TASK`: título, estado, prioridad, responsable y notas.

Los cambios de tarea en estado, prioridad o responsable generan `AUDIT_EVENT` con `changedFields`.

## Índices potenciales

Agregar índices solo cuando el patrón de consulta lo requiera:

- GSI para proyectos por usuario.
- GSI para tareas por responsable.
- GSI para tareas por estado.
- GSI para auditoría por entidad afectada.
