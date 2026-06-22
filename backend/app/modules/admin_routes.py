from core.request import Request
from core.router import Router
from responses import success
from services.admin import AdminService


def _users(req: Request):
    if req.method == "GET":
        return success(AdminService().list_users())
    return success(AdminService().create_user(req.body()), 201)


def _user_update(req: Request):
    email = req.params.get("email") or ""
    if req.method == "DELETE":
        return success(AdminService().delete_user(email, req.identity.get("email", "")))
    return success(AdminService().update_user(email, req.body()))


def register(router: Router) -> None:
    router.add(["GET", "POST"], "/api/admin/users", _users, admin=True,
               error_msg="Error inesperado al gestionar usuarios.")
    router.add(["PATCH", "DELETE"], "/api/admin/users/{email}", _user_update, admin=True,
               error_msg="Error inesperado al actualizar el usuario.")
