import os
from typing import Any

from repositories.dynamodb import MainTableRepository


DEFAULT_MODULES = [
    {"key": "home", "label": "Inicio", "enabled": True},
    {"key": "projects", "label": "Proyectos", "enabled": True},
    {"key": "tasks", "label": "Tareas", "enabled": True},
    {"key": "catalog", "label": "Catalogo", "enabled": True},
    {"key": "admin", "label": "Administracion", "enabled": True}
]


class UserNotConfiguredError(Exception):
    pass


class UserService:
    def __init__(self, repository: MainTableRepository | None = None) -> None:
        self._repository = repository or MainTableRepository()

    def get_me(self, identity: dict[str, str]) -> dict[str, Any]:
        profile = self._repository.get_user_profile(identity["userId"])
        if profile is None:
            raise UserNotConfiguredError("El usuario autenticado no esta configurado funcionalmente.")

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
        return modules

