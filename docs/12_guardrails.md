# Guardrails

Estas reglas son controles obligatorios durante la construcción.

## Producto

- Construir una experiencia interna ligera, centrada en proyectos, personas, tareas y datos.
- Mantener pantallas limpias, acciones evidentes y configuración proporcional al flujo.
- Validar el flujo básico de cada módulo antes de ampliar su complejidad.
- Presentar los servicios AWS mediante funciones del producto y abstraer su operación técnica.
- Mantener todo texto visible al usuario en español claro. Solo conservar términos en inglés cuando sean nombres técnicos, servicios AWS, comandos, rutas o identificadores de código.

## Seguridad

- Aplicar autorización efectiva en Lambda y usar el menú únicamente como reflejo de permisos.
- Separar autenticación en Cognito y autorización funcional en DynamoDB/Lambda.
- Obtener credenciales AWS mediante SSO y mantenerlas fuera del código, logs e interfaz.
- Servir el frontend mediante CloudFront con S3 privado.
- Calcular la visibilidad del catálogo para cada usuario.
- Mantener pocos roles globales y permisos granulares por módulo y proyecto.

## Data Lake

- Ejecutar en Athena únicamente consultas controladas de lectura y monitoreo.
- Realizar el CRUD operativo mediante servicios y repositorios DynamoDB.
- Guardar metadata técnica en Glue Catalog y contexto funcional en DynamoDB.
- Resolver los permisos funcionales de forma independiente a la metadata técnica.

## Implementación

- Mantener documentación sincronizada con comportamiento real.
- Documentar decisiones funcionales en español y reservar el inglés para nombres técnicos, comandos, rutas e identificadores.
- Preferir estructuras simples antes que abstracciones prematuras.
- Auditar cambios sensibles.
- Separar decisiones actuales de ideas futuras.
