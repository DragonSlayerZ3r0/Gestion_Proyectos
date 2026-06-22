"""Fuente única de los módulos del sistema (lado backend).
Las claves de autorización son granulares (projects y tasks por separado); la
agrupación visual "Proyectos y tareas" es decisión del frontend."""

MODULES = [
    {"key": "home", "label": "Inicio"},
    {"key": "projects", "label": "Proyectos"},
    {"key": "tasks", "label": "Tareas"},
    {"key": "catalog", "label": "Catálogo"},
    {"key": "admin", "label": "Administración"},
]

MODULE_KEYS = [m["key"] for m in MODULES]
