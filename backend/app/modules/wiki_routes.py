from core.request import Request
from core.router import Router
from responses import success
from services.wiki import WikiService

# Lectura = módulo wiki; escritura = sub-permiso wiki_editor (check hijo que el
# admin marca en Administración). El guard `modules` ya resuelve ambos: los
# sub-permisos se guardan como filas MODULE# igual que los módulos.
R = ["wiki"]
W = ["wiki_editor"]


def _list(req: Request):
    return success(WikiService().list_pages())


def _create(req: Request):
    service = WikiService()
    result = success(service.create_page(req.body(), req.identity), 201)
    # Limpieza de imágenes huérfanas: a lo sumo 1 vez/día, async, best-effort.
    service.maybe_start_cleanup(req.lambda_context.function_name)
    return result


def _page(req: Request):
    return success(WikiService().get_page(req.params.get("pageId") or ""))


def _page_update(req: Request):
    service = WikiService()
    page_id = req.params.get("pageId") or ""
    if req.method == "DELETE":
        result = success(service.delete_page(page_id, req.identity))
    else:
        result = success(service.update_page(page_id, req.body(), req.identity))
    service.maybe_start_cleanup(req.lambda_context.function_name)
    return result


def _revisions(req: Request):
    return success(WikiService().list_revisions(req.params.get("pageId") or ""))


def _revision(req: Request):
    return success(WikiService().get_revision(
        req.params.get("pageId") or "", req.params.get("revId") or ""))


def _presign_image(req: Request):
    return success(WikiService().presign_image(req.body(), req.identity))


def _image_url(req: Request):
    return success(WikiService().image_url(req.params.get("token") or ""))


def register(router: Router) -> None:
    router.add(["GET"], "/api/wiki", _list, modules=R,
               error_msg="Error inesperado al listar las páginas.")
    router.add(["POST"], "/api/wiki", _create, modules=W,
               error_msg="Error inesperado al crear la página.")
    # Literales ANTES de {pageId} (el router prioriza literales, pero igual).
    router.add(["POST"], "/api/wiki/images/presign", _presign_image, modules=W,
               error_msg="Error inesperado al preparar la subida de la imagen.")
    router.add(["GET"], "/api/wiki/images/{token}/url", _image_url, modules=R,
               error_msg="Error inesperado al cargar la imagen.")
    router.add(["GET"], "/api/wiki/{pageId}", _page, modules=R,
               error_msg="Error inesperado al cargar la página.")
    router.add(["PATCH", "DELETE"], "/api/wiki/{pageId}", _page_update, modules=W,
               error_msg="Error inesperado al guardar la página.")
    router.add(["GET"], "/api/wiki/{pageId}/revisions", _revisions, modules=R,
               error_msg="Error inesperado al cargar el historial.")
    router.add(["GET"], "/api/wiki/{pageId}/revisions/{revId}", _revision, modules=R,
               error_msg="Error inesperado al cargar la revisión.")
