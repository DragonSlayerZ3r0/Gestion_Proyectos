import os
from typing import Any

from core.errors import UserNotConfiguredError  # re-exportado para compatibilidad
from modules.manifest import MODULES
from repositories.users import UsersRepository


# Derivado del manifiesto único (fuente de verdad de los módulos).
DEFAULT_MODULES = [{**m, "enabled": True} for m in MODULES]

MODULE_ORDER = {module["key"]: index for index, module in enumerate(DEFAULT_MODULES)}

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

        return {
            "user": {
                "id": identity["userId"],
                "email": identity["email"],
                "name": profile.get("name") or identity["email"],
                "status": profile.get("status", "active"),
                "roles": profile.get("roles", ["user"])
            },
            "modules": modules,
            "environment": os.environ.get("ENV_NAME", "dev")
        }

    def _normalize_modules(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not items:
            return DEFAULT_MODULES

        modules = []
        for item in items:
            if item.get("enabled", False):
                modules.append({
                    "key": item["moduleKey"],
                    "label": item.get("label", item["moduleKey"]),
                    "enabled": True
                })
        return sorted(modules, key=lambda module: MODULE_ORDER.get(module["key"], 99))
