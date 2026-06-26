from core.request import Request
from core.router import Router
from responses import success
from services.users import UserService


def _health(_req: Request):
    return success({"status": "ok"})


def _me(req: Request):
    return success(UserService().get_me(req.identity))


def register(router: Router) -> None:
    router.add(["GET"], "/health", _health, auth=False)
    router.add(["GET"], "/api/me", _me, error_msg="Error inesperado al cargar el perfil.")
