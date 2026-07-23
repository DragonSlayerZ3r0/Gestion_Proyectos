"""Fuente ÚNICA de los módulos y pestañas del sistema.

Todo se deriva de aquí: etiquetas de Administración, módulos por defecto de un
usuario nuevo, pestañas de Inicio (`homeTabs` en /api/me) y también la MATRIZ de
asignación que pinta la pantalla de Administración (`admin_module_groups()`,
expuesta en GET /api/admin/users como `moduleGroups`). Agregar un módulo a
`MODULES` o una pestaña a `HOME_TABS` lo hace aparecer AUTOMÁTICAMENTE como
casilla configurable por usuario — no hay que tocar el frontend."""

MODULES = [
    # Clave histórica "home" con etiqueta visible "Panel" — NO renombrar la
    # clave: vive en DynamoDB por usuario (filas MODULE#home / home_*) y en
    # guards/rutas; renombrarla exigiría migración de datos sin ganancia.
    {"key": "home", "label": "Panel"},
    # Clave histórica "projects" con etiqueta "Solicitudes" (rename 2026-07-04).
    {"key": "projects", "label": "Solicitudes"},
    {"key": "tasks", "label": "Tareas"},
    {"key": "catalog", "label": "Catálogo"},
    # Pizarra (2026-07-07): lienzo Excalidraw con compartir selectivo (el dueño
    # invita, el invitado acepta/rechaza). Escenas en S3 (bucket de adjuntos,
    # prefijo drawings/); metadata DRAWING/DRAWING_SHARE en DynamoDB.
    {"key": "draw", "label": "Pizarra"},
    # Wiki (2026-07-22): base de conocimiento tipo Wikipedia. Todos los que
    # tengan el módulo LEEN; solo quienes además tengan el sub-permiso
    # wiki_editor (check hijo en Administración) crean/editan.
    {"key": "wiki", "label": "Wiki"},
    {"key": "chat", "label": "Apoyo técnico"},
    {"key": "admin", "label": "Administración"},
]

MODULE_KEYS = [m["key"] for m in MODULES]

# ── Sub-permisos de módulos ───────────────────────────────────────────────────
# Capacidades EXTRA dentro de un módulo (no son entradas de menú ni pestañas):
# se almacenan como filas MODULE#<key> igual que los módulos (mismo guard
# `modules=[...]` en las rutas), aparecen como check HIJO de su módulo padre en
# la matriz de Administración, y /api/me los publica en `capabilities` para que
# el frontend muestre/oculte las acciones. Agregar uno aquí basta — el patrón
# es el mismo de HOME_TABS pero para capacidades, no pestañas.
MODULE_SUBPERMS = [
    {"key": "wiki_editor", "label": "Editor (crear y editar páginas)", "parent": "wiki"},
]

SUBPERM_KEYS = [s["key"] for s in MODULE_SUBPERMS]

# Pestañas asignables dentro del módulo Inicio. Se almacenan y validan como
# permisos granulares (igual que los módulos), pero NO son entradas de menú: el
# frontend las consume desde el campo `homeTabs` de /api/me. Facturación y
# Athena son asignables desde Administración; si un usuario nunca fue
# configurado con esas claves, heredan el comportamiento previo (solo admins).
# 2026-07-06: la pestaña "Resumen" (home_resumen) se ELIMINÓ — su contenido era
# dominio de Solicitudes y ahora vive allá como "Tablero de avance". La clave
# home_resumen guardada por usuario queda inerte (regla: claves nunca se borran).
HOME_TABS = [
    {"key": "home_datalake", "label": "Panel · Data Lake"},
    {"key": "home_facturacion", "label": "Panel · Facturación"},
    {"key": "home_athena", "label": "Panel · Athena"},
]

# Pestañas cuyo default (sin configurar) es solo-admin, por compatibilidad con
# el comportamiento anterior a que fueran asignables.
ADMIN_DEFAULT_HOME_TABS = {"home_facturacion", "home_athena"}

# Pestañas de Inicio RETIRADAS: ya no existen, pero usuarios previos las tienen
# guardadas como fila MODULE#. Se siguen tratando como pestañas de Inicio SOLO
# para EXCLUIRLAS del menú (si no, se colarían como módulo de navegación y
# renderizarían andamiaje viejo). No se resuelven como pestañas funcionales.
RETIRED_HOME_TAB_KEYS = {"home_resumen"}

HOME_TAB_KEYS = [t["key"] for t in HOME_TABS]

# ── Matriz de asignación de Administración (derivada, no se edita a mano) ────
# Decisiones VISUALES declaradas como datos, no duplicadas en el frontend:
# - projects+tasks se presentan como UN solo grupo "Proyectos y tareas".
# - "home" va bloqueado (siempre habilitado: es el punto de entrada de la app).
# - Las HOME_TABS aparecen como hijas del Panel (su etiqueta corta, sin "Panel ·").
_MERGED_GROUPS = {
    "projects": {"label": "Solicitudes", "keys": ["projects", "tasks"]},
}
_MERGED_AWAY = {"tasks"}   # ya viven dentro del grupo projects

# Claves premarcadas en el formulario "Nuevo usuario". Facturación/Athena NO
# están: son datos sensibles y asignarlas es decisión explícita del admin.
DEFAULT_NEW_USER_KEYS = ["home", "home_datalake", "catalog"]


def admin_module_groups() -> list[dict]:
    """Grupos de casillas para la pantalla de Administración. Un módulo nuevo en
    MODULES sale como grupo propio; una pestaña nueva en HOME_TABS sale como hija
    de Inicio; un sub-permiso en MODULE_SUBPERMS sale como hija de su módulo
    padre — sin tocar nada más."""
    subperms_by_parent: dict[str, list[dict]] = {}
    for s in MODULE_SUBPERMS:
        subperms_by_parent.setdefault(s["parent"], []).append(
            {"key": s["key"], "label": s["label"]})
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
            group: dict = {"key": key, "label": m["label"], "keys": [key]}
            if key in subperms_by_parent:
                group["children"] = subperms_by_parent[key]
            groups.append(group)
    return groups
