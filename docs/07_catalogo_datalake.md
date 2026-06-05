# Catalogo Data Lake

## Objetivo

Permitir que usuarios autorizados exploren bases, tablas y columnas del Data Lake con contexto funcional entendible.

## Separacion de responsabilidades

```text
Glue Catalog = metadata tecnica
DynamoDB = contexto funcional
Athena = preview o consulta controlada
```

## Informacion desde Glue Catalog

- Bases de datos.
- Tablas.
- Columnas.
- Tipos de datos.
- Ubicacion tecnica si aplica.
- Particiones si aplica.

## Informacion guardada en DynamoDB

- Descripcion funcional de tabla.
- Owner funcional.
- Proyecto asociado.
- Nivel de sensibilidad.
- Reglas de uso.
- Descripcion funcional de columnas.
- Notas internas.
- Estado de documentacion.

## Relacion tabla-proyecto

Una tabla puede asociarse a uno o varios proyectos mediante `PROJECT_TABLE`.

Esto permite mostrar que datos usa cada proyecto y controlar visibilidad funcional.

## Preview con Athena

Athena solo debe usarse para consultas controladas:

- Limite de filas.
- Columnas permitidas.
- Sin SQL libre desde frontend.
- Validacion previa de permisos.
- Registro de auditoria cuando aplique.

## Visibilidad

No todos los usuarios deben ver todo el catalogo. La visibilidad debe depender de permisos por modulo, proyecto, tabla o regla funcional definida.
