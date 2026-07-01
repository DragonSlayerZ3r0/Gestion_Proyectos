# Backlog inicial

> Estado documental: backlog de arranque. Sus elementos describen el alcance que dio
> origen al primer corte; varios ya están implementados. Para trabajo pendiente y estado
> vigente, consultar [`15_estado_implementacion.md`](15_estado_implementacion.md) y
> [`20_roadmap_data_driven.md`](20_roadmap_data_driven.md).

## Base de proyecto

- Crear estructura frontend Astro.
- Crear estructura backend Lambda Python.
- Definir configuración por ambiente.
- Crear layout principal.
- Crear componentes base de navegación.

## Autenticación y perfil

- Implementar login Cognito.
- Implementar logout.
- Configurar API Gateway JWT Authorizer.
- Crear endpoint `GET /api/me`.
- Devolver perfil, módulos y permisos.

## Datos y permisos

- Crear tabla DynamoDB principal.
- Crear entidades `USER` y `USER_MODULE`.
- Implementar validación de permisos en Lambda.
- Crear auditoría base.

## Proyectos

- Crear módulo Proyectos.
- Crear endpoint para listar proyectos.
- Crear endpoint para crear proyecto.
- Crear detalle de proyecto.
- Agregar usuarios a proyecto.
- Definir project owner.

## Tareas

- Crear modulo Tareas.
- Crear tareas por proyecto.
- Cambiar estado de tareas.
- Permitir cambio de prioridad de tareas.
- Auditar cambio de prioridad.
- Agregar comentarios.
- Crear Kanban simple.

## Catálogo Data Lake

- Crear módulo Catálogo.
- Integrar Glue Catalog.
- Listar bases de datos permitidas.
- Listar tablas permitidas.
- Mostrar columnas.
- Guardar contexto funcional de tabla.
- Guardar contexto funcional de columnas.
- Asociar tablas a proyectos.

## Athena

- Configurar workgroup.
- Crear endpoint de preview controlado.
- Limitar filas.
- Bloquear SQL libre desde frontend.
- Auditar consultas cuando aplique.

## Administración

- Crear módulo Administración.
- Listar usuarios funcionales.
- Activar y desactivar usuarios.
- Habilitar módulos por usuario.
- Mostrar vista inicial de auditoría.
