# Contexto general

## Objetivo

Construir una plataforma interna para gestionar proyectos, tareas, accesos funcionales y contexto de datos disponibles en un Data Lake.

La plataforma debe servir como una base modular para equipos internos. Debe permitir iniciar con gestión de proyectos y tareas, y luego crecer hacia catálogo de datos, tableros, solicitudes, auditoría y administración.

## Problema que resuelve

- Falta de visibilidad clara sobre proyectos activos.
- Seguimiento disperso de tareas y responsables.
- Dificultad para saber qué tablas existen en el Data Lake y qué significan funcionalmente.
- Necesidad de controlar qué módulos y proyectos puede ver cada usuario.
- Necesidad de separar permisos técnicos de permisos funcionales.

## Publico usuario

- Usuarios internos que gestionan proyectos.
- Responsables de proyecto.
- Analistas de datos.
- Administradores funcionales.
- Equipos técnicos que mantienen la infraestructura AWS.

## Idioma del producto

El idioma funcional del proyecto es español. Todo texto visible al usuario, labels de módulos, mensajes, estados, documentación funcional y contenido de ayuda debe escribirse en español claro.

Se permiten términos técnicos en inglés cuando sean nombres propios o convenciones técnicas, por ejemplo `AWS`, `Cognito`, `CloudFront`, `DynamoDB`, `API Gateway`, rutas HTTP, nombres de clases, variables, comandos y archivos.

## Filosofía de diseño

La plataforma debe ser simple, clara y rápida. Debe priorizar pantallas limpias, pocos botones, navegación directa y acciones evidentes.

No debe parecer Jira. No debe obligar al usuario a entender una metodología compleja para crear una tarea, cambiar una prioridad o revisar un proyecto.

## Que no debe ser

- No debe ser un clon de Jira.
- No debe ser un reemplazo completo de gobierno de datos.
- No debe ser una consola técnica de AWS.
- No debe permitir SQL libre desde el frontend.
- No debe exponer todo el catálogo de datos a todos los usuarios.

## Módulos esperados

- Inicio.
- Proyectos.
- Tareas.
- Catálogo Data Lake.
- Tableros.
- Solicitudes.
- Administración.

## Principios generales

- Cognito identifica al usuario.
- DynamoDB define que puede hacer el usuario.
- Lambda aplica la seguridad real.
- El menú frontend solo refleja permisos ya calculados.
- Todo cambio sensible debe auditarse.
- La documentación debe actualizarse junto con la implementación.
