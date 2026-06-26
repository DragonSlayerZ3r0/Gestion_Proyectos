import os
from typing import Any

from core.errors import UserNotConfiguredError  # re-exportado para compatibilidad
from modules.manifest import MODULES, HOME_TAB_KEYS
from repositories.users import UsersRepository


# Derivado del manifiesto único (fuente de verdad de los módulos).
DEFAULT_MODULES = [{**m, "enabled": True} for m in MODULES]

MODULE_ORDER = {module["key"]: index for index, module in enumerate(DEFAULT_MODULES)}

_HOME_TAB_KEYS = set(HOME_TAB_KEYS)

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
        home_tabs = self._resolve_home_tabs(module_items)

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

        # Las pestañas de Inicio se excluyen del menú: van en `homeTabs`.
        modules = []
        for item in items:
            key = item["moduleKey"]
            if key in _HOME_TAB_KEYS:
                continue
            if item.get("enabled", False):
                modules.append({
                    "key": key,
                    "label": item.get("label", key),
                    "enabled": True
                })
        return sorted(modules, key=lambda module: MODULE_ORDER.get(module["key"], 99))

    def _resolve_home_tabs(self, items: list[dict[str, Any]]) -> list[str]:
        """Pestañas de Inicio visibles para el usuario (no incluye Facturación,
        que es admin-only). Si el usuario nunca fue configurado con estas claves
        (usuarios previos a la función), por defecto se habilitan todas."""
        tab_rows = [i for i in items if i.get("moduleKey") in _HOME_TAB_KEYS]
        if not tab_rows:
            return list(HOME_TAB_KEYS)
        return [i["moduleKey"] for i in tab_rows if i.get("enabled")]
