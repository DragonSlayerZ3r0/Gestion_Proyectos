# Guardrails

Estas reglas no deben romperse durante la construcción.

## Producto

- No hacer una interfaz tipo Jira.
- No sobrecargar pantallas con botones o configuraciones.
- No introducir módulos complejos antes de validar el flujo básico.
- No mezclar objetivos de gestión de proyectos con una consola técnica AWS.
- Mantener todo texto visible al usuario en español claro. Solo conservar términos en inglés cuando sean nombres técnicos, servicios AWS, comandos, rutas o identificadores de código.

## Seguridad

- No confiar solo en ocultar menús.
- Validar siempre permisos en Lambda.
- No mezclar autenticación con autorización.
- No exponer credenciales AWS.
- No usar S3 publico para el frontend.
- No mostrar todo el catalogo a todos los usuarios.
- No crear demasiados roles al inicio.

## Data Lake

- No permitir SQL libre desde frontend.
- No usar Athena para CRUD.
- No guardar contexto funcional en Glue Catalog.
- No asumir que metadata técnica equivale a permiso funcional.

## Implementación

- Mantener documentación sincronizada con comportamiento real.
- Documentar decisiones funcionales en español. Evitar mezclar inglés operativo en pantallas, mensajes, títulos o labels funcionales.
- Preferir estructuras simples antes que abstracciones prematuras.
- Auditar cambios sensibles.
- Separar decisiones actuales de ideas futuras.
