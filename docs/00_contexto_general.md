# Contexto general

## Objetivo

Construir una plataforma interna para gestionar proyectos, tareas, accesos funcionales y contexto de datos disponibles en un Data Lake.

La plataforma debe servir como una base modular para equipos internos. Debe permitir iniciar con gestion de proyectos y tareas, y luego crecer hacia catalogo de datos, tableros, solicitudes, auditoria y administracion.

## Problema que resuelve

- Falta de visibilidad clara sobre proyectos activos.
- Seguimiento disperso de tareas y responsables.
- Dificultad para saber que tablas existen en el Data Lake y que significan funcionalmente.
- Necesidad de controlar que modulos y proyectos puede ver cada usuario.
- Necesidad de separar permisos tecnicos de permisos funcionales.

## Publico usuario

- Usuarios internos que gestionan proyectos.
- Project owners.
- Analistas de datos.
- Administradores funcionales.
- Equipos tecnicos que mantienen la infraestructura AWS.

## Filosofia de diseno

La plataforma debe ser simple, clara y rapida. Debe priorizar pantallas limpias, pocos botones, navegacion directa y acciones evidentes.

No debe parecer Jira. No debe obligar al usuario a entender una metodologia compleja para crear una tarea, cambiar una prioridad o revisar un proyecto.

## Que no debe ser

- No debe ser un clon de Jira.
- No debe ser un reemplazo completo de gobierno de datos.
- No debe ser una consola tecnica de AWS.
- No debe permitir SQL libre desde el frontend.
- No debe exponer todo el catalogo de datos a todos los usuarios.

## Modulos esperados

- Inicio.
- Proyectos.
- Tareas.
- Catalogo Data Lake.
- Tableros.
- Solicitudes.
- Administracion.

## Principios generales

- Cognito identifica al usuario.
- DynamoDB define que puede hacer el usuario.
- Lambda aplica la seguridad real.
- El menu frontend solo refleja permisos ya calculados.
- Todo cambio sensible debe auditarse.
- La documentacion debe actualizarse junto con la implementacion.
