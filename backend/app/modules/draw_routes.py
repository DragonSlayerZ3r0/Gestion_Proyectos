from core.request import Request
from core.router import Router
from responses import success
from services.drawings import DrawingService


def _list(req: Request):
    return success(DrawingService().list_for_user(req.identity))


def _people(req: Request):
    return success(DrawingService().list_people(req.identity))


def _create(req: Request):
    return success(DrawingService().create(req.body(), req.identity), 201)


def _drawing_update(req: Request):
    service = DrawingService()
    drawing_id = req.params.get("drawingId") or ""
    if req.method == "DELETE":
        return success(service.delete(drawing_id, req.identity))
    return success(service.rename(drawing_id, req.body(), req.identity))


def _load_url(req: Request):
    return success(DrawingService().load_url(req.params.get("drawingId") or "", req.identity))


def _save_url(req: Request):
    return success(DrawingService().save_url(req.params.get("drawingId") or "", req.identity))


def _share(req: Request):
    drawing_id = req.params.get("drawingId") or ""
    return success(DrawingService().share(drawing_id, req.body(), req.identity), 201)


def _revoke_share(req: Request):
    drawing_id = req.params.get("drawingId") or ""
    email = req.params.get("email") or ""
    return success(DrawingService().revoke_share(drawing_id, email, req.identity))


def _respond(req: Request):
    drawing_id = req.params.get("drawingId") or ""
    return success(DrawingService().respond(drawing_id, req.body(), req.identity))


def register(router: Router) -> None:
    D = ["draw"]
    router.add(["GET"], "/api/draw", _list, modules=D,
               error_msg="Error inesperado al cargar las pizarras.")
    router.add(["GET"], "/api/draw/users", _people, modules=D,
               error_msg="Error inesperado al cargar los usuarios.")
    router.add(["POST"], "/api/draw", _create, modules=D,
               error_msg="Error inesperado al crear la pizarra.")
    router.add(["PATCH", "DELETE"], "/api/draw/{drawingId}", _drawing_update, modules=D,
               error_msg="Error inesperado al actualizar la pizarra.")
    router.add(["GET"], "/api/draw/{drawingId}/url", _load_url, modules=D,
               error_msg="Error inesperado al abrir la pizarra.")
    router.add(["POST"], "/api/draw/{drawingId}/save-url", _save_url, modules=D,
               error_msg="Error inesperado al guardar la pizarra.")
    router.add(["POST"], "/api/draw/{drawingId}/shares", _share, modules=D,
               error_msg="Error inesperado al compartir la pizarra.")
    router.add(["DELETE"], "/api/draw/{drawingId}/shares/{email}", _revoke_share, modules=D,
               error_msg="Error inesperado al quitar el acceso.")
    router.add(["POST"], "/api/draw/{drawingId}/respond", _respond, modules=D,
               error_msg="Error inesperado al responder la invitación.")
