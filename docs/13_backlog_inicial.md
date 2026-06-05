# Backlog inicial

## Base de proyecto

- Crear estructura frontend Astro.
- Crear estructura backend Lambda Python.
- Definir configuracion por ambiente.
- Crear layout principal.
- Crear componentes base de navegacion.

## Autenticacion y perfil

- Implementar login Cognito.
- Implementar logout.
- Configurar API Gateway JWT Authorizer.
- Crear endpoint `GET /api/me`.
- Devolver perfil, modulos y permisos.

## Datos y permisos

- Crear tabla DynamoDB principal.
- Crear entidades `USER` y `USER_MODULE`.
- Implementar validacion de permisos en Lambda.
- Crear auditoria base.

## Proyectos

- Crear modulo Proyectos.
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

## Catalogo Data Lake

- Crear modulo Catalogo.
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

## Administracion

- Crear modulo Admin.
- Listar usuarios funcionales.
- Activar y desactivar usuarios.
- Habilitar modulos por usuario.
- Mostrar vista inicial de auditoria.
