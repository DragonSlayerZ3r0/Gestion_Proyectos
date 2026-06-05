# Fases de implementación

## Fase 1: Base técnica

- Objetivo: crear estructura inicial de frontend, backend e infraestructura.
- Funcionalidad incluida: layout base, Lambda base, configuración de ambientes.
- Criterios de aceptación: proyecto ejecuta localmente y tiene estructura documentada.

## Fase 2: Login y /api/me

- Objetivo: autenticar usuario y obtener perfil funcional.
- Funcionalidad incluida: Cognito, JWT, endpoint `/api/me`.
- Criterios de aceptación: usuario autenticado recibe módulos y permisos.

## Fase 3: Usuarios y accesos

- Objetivo: administrar usuarios funcionales y módulos.
- Funcionalidad incluida: tabla DynamoDB, permisos por módulo, vista admin inicial.
- Criterios de aceptación: admin habilita o deshabilita módulos por usuario.

## Fase 4: Proyectos

- Objetivo: crear y consultar proyectos.
- Funcionalidad incluida: CRUD básico, miembros, responsable.
- Criterios de aceptación: usuarios autorizados gestionan proyectos.

## Fase 5: Tareas

- Objetivo: gestionar tareas por proyecto.
- Funcionalidad incluida: estados, prioridades, responsables, comentarios.
- Criterios de aceptación: prioridad cambia en cualquier estado y queda auditada.

## Fase 6: Catálogo Glue

- Objetivo: listar metadata técnica permitida.
- Funcionalidad incluida: bases, tablas y columnas desde Glue Catalog.
- Criterios de aceptación: usuario solo ve recursos autorizados.

## Fase 7: Contexto funcional

- Objetivo: documentar tablas y columnas.
- Funcionalidad incluida: contexto funcional en DynamoDB.
- Criterios de aceptación: metadata técnica y contexto funcional se muestran juntos.

## Fase 8: Athena preview

- Objetivo: previsualizar datos de forma controlada.
- Funcionalidad incluida: consultas limitadas y seguras.
- Criterios de aceptación: no existe SQL libre desde frontend.

## Fase 9: Tableros

- Objetivo: mostrar indicadores y resúmenes.
- Funcionalidad incluida: paneles internos iniciales.
- Criterios de aceptación: tableros respetan permisos.

## Fase 10: Auditoría y mejoras

- Objetivo: robustecer trazabilidad y experiencia.
- Funcionalidad incluida: filtros de auditoría, mejoras de UX, manejo de errores.
- Criterios de aceptación: acciones sensibles pueden revisarse por auditoría.
