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

## pypdf 6.14.2 (puro-Python, sin dependencias nativas)

Extracción de texto de los PDFs adjuntos de la **Wiki** (`services/wiki.py`,
`process_document`): al confirmar la subida se extrae el texto y se guarda como
sidecar `.txt` en S3 — es lo que se indexa en embeddings y lo que "lee" el LLM
en «Preguntar a la Wiki». Un PDF escaneado (sin capa de texto) produce texto
vacío: se detecta y se avisa al editor.

- Origen: `pip install pypdf==6.14.2` (solo el core; los extras crypto/imagen no se usan).
- `typing_extensions.py` acompaña por si el intérprete local es < 3.11 (el runtime
  del Lambda es 3.12 y no lo necesita).
- Si faltara, la extracción degrada a "sin texto extraíble" (el adjunto sigue funcionando).
- Actualizar: reinstalar en un temporal y copiar el directorio `pypdf/` aquí.
