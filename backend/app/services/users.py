import os
from typing import Any

from core.errors import UserNotConfiguredError  # re-exportado para compatibilidad
from modules.manifest import ADMIN_DEFAULT_HOME_TABS, HOME_TAB_KEYS, MODULES, RETIRED_HOME_TAB_KEYS
from repositories.users import UsersRepository


# Derivado del manifiesto único (fuente de verdad de los módulos).
DEFAULT_MODULES = [{**m, "enabled": True} for m in MODULES]

# Etiqueta VIGENTE por clave. Las filas MODULE# de DynamoDB guardan una copia de
# la etiqueta al momento de configurar al usuario; si después se renombra en el
# manifiesto (ej. "Inicio" → "Panel"), aquí se impone la actual sin migrar datos.
_CURRENT_LABELS = {m["key"]: m["label"] for m in MODULES}

MODULE_ORDER = {module["key"]: index for index, module in enumerate(DEFAULT_MODULES)}

_HOME_TAB_KEYS = set(HOME_TAB_KEYS)
# Claves excluidas del MENÚ (pestañas activas + retiradas): las retiradas ya no
# son pestañas, pero siguen sin ser entradas de navegación.
_MENU_EXCLUDE_KEYS = _HOME_TAB_KEYS | set(RETIRED_HOME_TAB_KEYS)

__all__ = ["UserService", "UserNotConfiguredError", "DEFAULT_MODULES", "MODULE_ORDER"]


class UserService:
    def __init__(self, repository: UsersRepository | None = None) -> None:
        self._repository = repository or UsersRepository()

    def get_me(self, identity: dict[str, str]) -> dict[str, Any]:
        profile = self._repository.get_user_profile(identity["userId"])
        if profile is None:
            raise UserNotConfiguredError("El usuario autenticado no está configurado funcionalmente.")

        module_items = self._repository.list_user_modules(identity["userId"])
        modules = self._normalize_modules(module_items)
        home_tabs = self._resolve_home_tabs(module_items, profile.get("roles", ["user"]))

        return {
            "user": {
                "id": identity["userId"],
                "email": identity["email"],
                "name": profile.get("name") or identity["email"],
                "status": profile.get("status", "active"),
                "roles": profile.get("roles", ["user"])
            },
            "modules": modules,
            "homeTabs": home_tabs,
            "environment": os.environ.get("ENV_NAME", "dev")
        }

    def _normalize_modules(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not items:
            return DEFAULT_MODULES

        # Las pestañas de Inicio (activas o retiradas) se excluyen del menú: las
        # activas van en `homeTabs`; las retiradas quedan inertes.
        modules = []
        for item in items:
            key = item["moduleKey"]
            if key in _MENU_EXCLUDE_KEYS:
                continue
            if item.get("enabled", False):
                modules.append({
                    "key": key,
                    "label": _CURRENT_LABELS.get(key) or item.get("label", key),
                    "enabled": True
                })
        return sorted(modules, key=lambda module: MODULE_ORDER.get(module["key"], 99))

    def _resolve_home_tabs(self, items: list[dict[str, Any]], roles: list[str]) -> list[str]:
        """Pestañas de Inicio visibles para el usuario. Clave configurada → se
        respeta lo asignado en Administración. Clave NUNCA configurada (usuarios
        previos a que existiera) → default por compatibilidad: Resumen/Data Lake
        habilitadas; Facturación/Athena solo si es admin (comportamiento previo)."""
        rows = {i["moduleKey"]: bool(i.get("enabled"))
                for i in items if i.get("moduleKey") in _HOME_TAB_KEYS}
        is_admin = "admin" in (roles or [])
        tabs: list[str] = []
        for key in HOME_TAB_KEYS:
            if key in rows:
                enabled = rows[key]
            else:
                enabled = is_admin if key in ADMIN_DEFAULT_HOME_TABS else True
            if enabled:
                tabs.append(key)
        return tabs
