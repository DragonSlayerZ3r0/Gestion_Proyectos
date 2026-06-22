"""Controles de autorización reutilizables. Se aplican declarativamente desde el
registro de rutas (modules=..., admin=True), no a mano en cada handler."""
from typing import Any

from repositories.users import UsersRepository


def ensure_module_access(identity: dict[str, str], module_keys: list[str]) -> None:
    modules = UsersRepository().list_user_modules(identity["userId"])
    if not modules:
        raise PermissionError("No tienes permiso para usar este módulo.")
    enabled = {item.get("moduleKey") for item in modules if item.get("enabled")}
    if not any(key in enabled for key in module_keys):
        raise PermissionError("No tienes permiso para usar este módulo.")


def ensure_admin(identity: dict[str, str]) -> None:
    """Solo rol `admin` y estado activo."""
    profile = UsersRepository().get_user_profile(identity["userId"])
    if profile is None:
        raise PermissionError("No tienes permiso para esta operación.")
    roles = profile.get("roles", [])
    if "admin" not in roles or profile.get("status", "active") != "active":
        raise PermissionError("No tienes permiso para esta operación.")
