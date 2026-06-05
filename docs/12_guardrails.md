# Guardrails

Estas reglas no deben romperse durante la construccion.

## Producto

- No hacer una interfaz tipo Jira.
- No sobrecargar pantallas con botones o configuraciones.
- No introducir modulos complejos antes de validar el flujo basico.
- No mezclar objetivos de gestion de proyectos con una consola tecnica AWS.

## Seguridad

- No confiar solo en ocultar menus.
- Validar siempre permisos en Lambda.
- No mezclar autenticacion con autorizacion.
- No exponer credenciales AWS.
- No usar S3 publico para el frontend.
- No mostrar todo el catalogo a todos los usuarios.
- No crear demasiados roles al inicio.

## Data Lake

- No permitir SQL libre desde frontend.
- No usar Athena para CRUD.
- No guardar contexto funcional en Glue Catalog.
- No asumir que metadata tecnica equivale a permiso funcional.

## Implementacion

- Mantener documentacion sincronizada con comportamiento real.
- Preferir estructuras simples antes que abstracciones prematuras.
- Auditar cambios sensibles.
- Separar decisiones actuales de ideas futuras.
