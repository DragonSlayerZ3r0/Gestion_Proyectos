"""Fuente ÚNICA de los módulos y pestañas del sistema.

Todo se deriva de aquí: etiquetas de Administración, módulos por defecto de un
usuario nuevo, pestañas de Inicio (`homeTabs` en /api/me) y también la MATRIZ de
asignación que pinta la pantalla de Administración (`admin_module_groups()`,
expuesta en GET /api/admin/users como `moduleGroups`). Agregar un módulo a
`MODULES` o una pestaña a `HOME_TABS` lo hace aparecer AUTOMÁTICAMENTE como
casilla configurable por usuario — no hay que tocar el frontend."""

MODULES = [
    {"key": "home", "label": "Inicio"},
    {"key": "projects", "label": "Proyectos"},
    {"key": "tasks", "label": "Tareas"},
    {"key": "catalog", "label": "Catálogo"},
    {"key": "chat", "label": "Apoyo técnico"},
    {"key": "admin", "label": "Administración"},
]

MODULE_KEYS = [m["key"] for m in MODULES]

# Pestañas asignables dentro del módulo Inicio. Se almacenan y validan como
# permisos granulares (igual que los módulos), pero NO son entradas de menú: el
# frontend las consume desde el campo `homeTabs` de /api/me. Facturación y
# Athena son asignables desde Administración; si un usuario nunca fue
# configurado con esas claves, heredan el comportamiento previo (solo admins).
HOME_TABS = [
    {"key": "home_resumen", "label": "Inicio · Resumen"},
    {"key": "home_datalake", "label": "Inicio · Data Lake"},
    {"key": "home_facturacion", "label": "Inicio · Facturación"},
    {"key": "home_athena", "label": "Inicio · Athena"},
]

# Pestañas cuyo default (sin configurar) es solo-admin, por compatibilidad con
# el comportamiento anterior a que fueran asignables.
ADMIN_DEFAULT_HOME_TABS = {"home_facturacion", "home_athena"}

HOME_TAB_KEYS = [t["key"] for t in HOME_TABS]

# ── Matriz de asignación de Administración (derivada, no se edita a mano) ────
# Decisiones VISUALES declaradas como datos, no duplicadas en el frontend:
# - projects+tasks se presentan como UN solo grupo "Proyectos y tareas".
# - "home" va bloqueado (siempre habilitado: es el punto de entrada de la app).
# - Las HOME_TABS aparecen como hijas de Inicio (su etiqueta corta, sin "Inicio ·").
_MERGED_GROUPS = {
    "projects": {"label": "Proyectos y tareas", "keys": ["projects", "tasks"]},
}
_MERGED_AWAY = {"tasks"}   # ya viven dentro del grupo projects

# Claves premarcadas en el formulario "Nuevo usuario". Facturación/Athena NO
# están: son datos sensibles y asignarlas es decisión explícita del admin.
DEFAULT_NEW_USER_KEYS = ["home", "home_resumen", "home_datalake", "catalog"]


def admin_module_groups() -> list[dict]:
    """Grupos de casillas para la pantalla de Administración. Un módulo nuevo en
    MODULES sale como grupo propio; una pestaña nueva en HOME_TABS sale como hija
    de Inicio — sin tocar nada más."""
    groups: list[dict] = []
    for m in MODULES:
        key = m["key"]
        if key in _MERGED_AWAY:
            continue
        if key == "home":
            groups.append({
                "key": "home", "label": m["label"], "keys": ["home"], "locked": True,
                "children": [
                    {"key": t["key"], "label": t["label"].split("·")[-1].strip()}
                    for t in HOME_TABS
                ],
            })
        elif key in _MERGED_GROUPS:
            g = _MERGED_GROUPS[key]
            groups.append({"key": key, "label": g["label"], "keys": list(g["keys"])})
        else:
            groups.append({"key": key, "label": m["label"], "keys": [key]})
    return groups
