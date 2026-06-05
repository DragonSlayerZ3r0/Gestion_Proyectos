# Fases de implementacion

## Fase 1: Base tecnica

- Objetivo: crear estructura inicial de frontend, backend e infraestructura.
- Funcionalidad incluida: layout base, Lambda base, configuracion de ambientes.
- Criterios de aceptacion: proyecto ejecuta localmente y tiene estructura documentada.

## Fase 2: Login y /api/me

- Objetivo: autenticar usuario y obtener perfil funcional.
- Funcionalidad incluida: Cognito, JWT, endpoint `/api/me`.
- Criterios de aceptacion: usuario autenticado recibe modulos y permisos.

## Fase 3: Usuarios y accesos

- Objetivo: administrar usuarios funcionales y modulos.
- Funcionalidad incluida: tabla DynamoDB, permisos por modulo, vista admin inicial.
- Criterios de aceptacion: admin habilita o deshabilita modulos por usuario.

## Fase 4: Proyectos

- Objetivo: crear y consultar proyectos.
- Funcionalidad incluida: CRUD basico, miembros, owner.
- Criterios de aceptacion: usuarios autorizados gestionan proyectos.

## Fase 5: Tareas

- Objetivo: gestionar tareas por proyecto.
- Funcionalidad incluida: estados, prioridades, responsables, comentarios.
- Criterios de aceptacion: prioridad cambia en cualquier estado y queda auditada.

## Fase 6: Catalogo Glue

- Objetivo: listar metadata tecnica permitida.
- Funcionalidad incluida: bases, tablas y columnas desde Glue Catalog.
- Criterios de aceptacion: usuario solo ve recursos autorizados.

## Fase 7: Contexto funcional

- Objetivo: documentar tablas y columnas.
- Funcionalidad incluida: contexto funcional en DynamoDB.
- Criterios de aceptacion: metadata tecnica y contexto funcional se muestran juntos.

## Fase 8: Athena preview

- Objetivo: previsualizar datos de forma controlada.
- Funcionalidad incluida: consultas limitadas y seguras.
- Criterios de aceptacion: no existe SQL libre desde frontend.

## Fase 9: Tableros

- Objetivo: mostrar indicadores y resumenes.
- Funcionalidad incluida: paneles internos iniciales.
- Criterios de aceptacion: tableros respetan permisos.

## Fase 10: Auditoria y mejoras

- Objetivo: robustecer trazabilidad y experiencia.
- Funcionalidad incluida: filtros de auditoria, mejoras de UX, manejo de errores.
- Criterios de aceptacion: acciones sensibles pueden revisarse por auditoria.
