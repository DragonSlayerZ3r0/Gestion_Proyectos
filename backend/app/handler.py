from typing import Any

from auth import get_user_identity
from responses import error, success
from services.users import UserNotConfiguredError, UserService


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")

    if method == "GET" and path == "/health":
        return success({"status": "ok"})

    if method == "GET" and path == "/api/me":
        return get_me(event)

    return error("NOT_FOUND", "Ruta no encontrada.", 404)


def get_me(event: dict[str, Any]) -> dict[str, Any]:
    try:
        identity = get_user_identity(event)
        data = UserService().get_me(identity)
        return success(data)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except UserNotConfiguredError as exc:
        return error("USER_NOT_CONFIGURED", str(exc), 403)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al cargar el perfil.", 500)

