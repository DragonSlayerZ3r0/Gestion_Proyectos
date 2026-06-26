# Dependencias vendorizadas

Librerías de terceros incluidas directamente en el repo porque el Lambda se
empaqueta con `lambda.Code.fromAsset("../backend/app")` **sin bundling de pip**
(solo `boto3` viene del runtime). Vendorizar evita introducir capas o cambiar el
flujo de despliegue.

## sqlglot 30.11.0 (puro-Python, sin dependencias nativas)

Parser SQL por AST usado por `services/athena_monitor.py` (`_lint_sql`) para
detectar antipatrones en las consultas de Athena (SELECT \*, tablas sin base de
datos, sin WHERE, ORDER BY sin LIMIT) y devolver los tramos a resaltar.

- Origen: `pip install sqlglot==30.11.0` (paquete puro-Python; se eliminó cualquier `.so`).
- Se importa vía `sys.path` desde el servicio; si faltara, `_lint_sql` degrada a "sin hallazgos".
- Actualizar: reinstalar la versión deseada en un temporal y copiar el directorio `sqlglot/` aquí.
