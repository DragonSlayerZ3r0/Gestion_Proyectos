# Modulos funcionales

## Principio de menu dinamico

Cada usuario solo ve los modulos que tiene habilitados. Ocultar un modulo en frontend mejora la experiencia, pero no reemplaza la validacion obligatoria de permisos en Lambda.

## Inicio

Pantalla principal con resumen de proyectos, tareas asignadas, accesos disponibles y actividad relevante.

## Proyectos

Modulo para crear, editar, consultar y administrar proyectos. Debe permitir responsables, estado, descripcion, usuarios asociados y relacion con tablas del Data Lake cuando aplique.

## Tareas

Modulo para seguimiento simple de tareas por proyecto. Debe permitir estados, prioridades, responsables, fechas, comentarios y movimiento tipo Kanban simple.

## Catalogo Data Lake

Modulo para explorar bases, tablas y columnas permitidas. Debe combinar metadata tecnica de Glue Catalog con contexto funcional guardado en DynamoDB.

## Tableros

Modulo futuro para vistas resumidas, indicadores y paneles internos.

## Solicitudes

Modulo futuro para solicitudes de acceso, cambios, revisiones o trabajo asociado a proyectos y datos.

## Administracion

Modulo para usuarios con permisos administrativos. Inicialmente gestiona accesos globales, modulos por usuario, activacion funcional y auditoria.
