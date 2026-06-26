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

# Pestañas asignables dentro del módulo Inicio. Se almacenan y validan como
# permisos granulares (igual que los módulos), pero NO son entradas de menú: el
# frontend las consume desde el campo `homeTabs` de /api/me. La pestaña
# Facturación NO está aquí: es exclusiva de administradores y se controla por rol.
HOME_TABS = [
    {"key": "home_resumen", "label": "Inicio · Resumen"},
    {"key": "home_datalake", "label": "Inicio · Data Lake"},
]

HOME_TAB_KEYS = [t["key"] for t in HOME_TABS]
