# Módulos funcionales

## Principio de menú dinámico

Cada usuario solo ve los módulos que tiene habilitados. Ocultar un módulo en frontend mejora la experiencia, pero no reemplaza la validación obligatoria de permisos en Lambda.

## Inicio

Pantalla principal con resumen de proyectos, tareas asignadas, accesos disponibles y actividad relevante.

## Proyectos y tareas

Módulo operativo principal para crear, editar, consultar y administrar proyectos, tareas y personas asignadas desde una sola pantalla.

Aunque los permisos técnicos puedan existir como `projects` y `tasks`, el frontend debe presentarlos como una sola entrada: `Proyectos y tareas`. No se debe obligar al usuario a cambiar de ventana para crear o revisar tareas del proyecto activo.

Debe permitir responsables, estado, descripción, usuarios asociados, tareas por proyecto, prioridades, fechas, comentarios, movimiento Kanban simple y relación con tablas del Data Lake cuando aplique.

## Catálogo Data Lake

Módulo para explorar bases, tablas y columnas permitidas. Debe combinar metadata técnica de Glue Catalog con contexto funcional guardado en DynamoDB.

## Tableros

Módulo futuro para vistas resumidas, indicadores y paneles internos.

## Solicitudes

Módulo futuro para solicitudes de acceso, cambios, revisiones o trabajo asociado a proyectos y datos.

## Administración

Módulo para usuarios con permisos administrativos. Inicialmente gestiona accesos globales, módulos por usuario, activación funcional y auditoría.
