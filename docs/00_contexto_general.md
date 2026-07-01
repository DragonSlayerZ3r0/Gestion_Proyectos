# Contexto general

## Objetivo

Construir una plataforma interna para gestionar proyectos, tareas, accesos funcionales y contexto de datos disponibles en un Data Lake.

La plataforma sirve como base modular para equipos internos. Integra gestión de proyectos y tareas, catálogo de datos, tableros operativos, auditoría y administración, con puntos de extensión para nuevos módulos.

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

La plataforma es simple, clara y rápida. Prioriza pantallas limpias, pocos botones, navegación directa y acciones evidentes.

Los flujos permiten crear una tarea, cambiar una prioridad o revisar un proyecto mediante acciones directas y lenguaje funcional del equipo.

## Alcance y límites del producto

- La gestión de proyectos utiliza un modelo operativo ligero de proyectos, personas, tareas y Kanban.
- El catálogo complementa el gobierno de datos con metadata técnica y contexto funcional.
- Los servicios AWS se presentan mediante funciones del producto y permanecen abstraídos detrás del backend.
- Las consultas de datos se ejecutan mediante operaciones controladas en el backend.
- La visibilidad del catálogo se calcula según los permisos funcionales de cada usuario.

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
