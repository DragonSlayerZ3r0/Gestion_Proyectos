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
