from core.request import Request
from core.router import Router
from responses import success
from services.attachments import AttachmentService
from services.workspace import WorkspaceService


def _get_workspace(req: Request):
    return success(WorkspaceService().get_workspace())


def _create_area(req: Request):
    return success(WorkspaceService().create_area(req.body(), req.identity), 201)


def _area_update(req: Request):
    service = WorkspaceService()
    area_id = req.params.get("areaId") or ""
    if req.method == "DELETE":
        return success(service.delete_area(area_id, req.identity))
    return success(service.update_area(area_id, req.body(), req.identity))


def _create_status(req: Request):
    return success(WorkspaceService().create_status(req.body(), req.identity), 201)


def _status_update(req: Request):
    service = WorkspaceService()
    status_id = req.params.get("statusId") or ""
    if req.method == "DELETE":
        return success(service.delete_status(status_id, req.identity))
    return success(service.update_status(status_id, req.body(), req.identity))


def _create_person(req: Request):
    return success(WorkspaceService().create_person(req.body(), req.identity), 201)


def _person_update(req: Request):
    service = WorkspaceService()
    person_id = req.params.get("personId") or ""
    if req.method == "DELETE":
        return success(service.delete_person(person_id, req.identity))
    return success(service.update_person(person_id, req.body(), req.identity))


def _create_project(req: Request):
    return success(WorkspaceService().create_project(req.body(), req.identity), 201)


def _project_update(req: Request):
    service = WorkspaceService()
    project_id = req.params.get("projectId") or ""
    if req.method == "DELETE":
        return success(service.delete_project(project_id, req.identity))
    return success(service.update_project(project_id, req.body(), req.identity))


def _add_member(req: Request):
    project_id = req.params.get("projectId") or ""
    return success(WorkspaceService().add_project_member(project_id, req.body(), req.identity), 201)


def _member_update(req: Request):
    service = WorkspaceService()
    project_id = req.params.get("projectId") or ""
    person_id = req.params.get("personId") or ""
    if req.method == "DELETE":
        return success(service.remove_project_member(project_id, person_id, req.identity))
    return success(service.update_project_member(project_id, person_id, req.body(), req.identity))


def _create_update(req: Request):
    project_id = req.params.get("projectId") or ""
    return success(WorkspaceService().create_project_update(project_id, req.body(), req.identity), 201)


def _update_update(req: Request):
    service = WorkspaceService()
    project_id = req.params.get("projectId") or ""
    update_id = req.params.get("updateId") or ""
    if req.method == "DELETE":
        return success(service.delete_project_update(project_id, update_id, req.identity))
    return success(service.update_project_update(project_id, update_id, req.body(), req.identity))


def _create_task(req: Request):
    project_id = req.params.get("projectId") or ""
    return success(WorkspaceService().create_task(project_id, req.body(), req.identity), 201)


def _task_update(req: Request):
    service = WorkspaceService()
    project_id = req.params.get("projectId") or ""
    task_id = req.params.get("taskId") or ""
    if req.method == "DELETE":
        return success(service.delete_task(project_id, task_id, req.identity))
    return success(service.update_task(project_id, task_id, req.body(), req.identity))


def _presign_attachment(req: Request):
    project_id = req.params.get("projectId") or ""
    return success(AttachmentService().presign_upload(project_id, req.body(), req.identity), 201)


def _create_attachment(req: Request):
    # Un solo endpoint para confirmar un archivo ya subido (kind=file) o crear una
    # query de texto (kind=query); el discriminador viene en el cuerpo.
    service = AttachmentService()
    project_id = req.params.get("projectId") or ""
    body = req.body()
    if (body.get("kind") or "").strip() == "query":
        return success(service.create_query(project_id, body, req.identity), 201)
    return success(service.confirm_upload(project_id, body, req.identity), 201)


def _attachment_url(req: Request):
    project_id = req.params.get("projectId") or ""
    attachment_id = req.params.get("attachmentId") or ""
    return success(AttachmentService().get_download_url(project_id, attachment_id, req.identity))


def _attachment_update(req: Request):
    service = AttachmentService()
    project_id = req.params.get("projectId") or ""
    attachment_id = req.params.get("attachmentId") or ""
    if req.method == "DELETE":
        return success(service.delete(project_id, attachment_id, req.identity))
    return success(service.relate(project_id, attachment_id, req.body(), req.identity))


def register(router: Router) -> None:
    P = ["projects"]
    T = ["tasks"]
    router.add(["GET"], "/api/workspace", _get_workspace, modules=["projects", "tasks"],
               error_msg="Error inesperado al cargar el espacio de trabajo.")
    router.add(["POST"], "/api/areas", _create_area, modules=P,
               error_msg="Error inesperado al crear el área solicitante.")
    router.add(["PATCH", "DELETE"], "/api/areas/{areaId}", _area_update, modules=P,
               error_msg="Error inesperado al actualizar el área solicitante.")
    router.add(["POST"], "/api/project-statuses", _create_status, modules=P,
               error_msg="Error inesperado al crear el estado.")
    router.add(["PATCH", "DELETE"], "/api/project-statuses/{statusId}", _status_update, modules=P,
               error_msg="Error inesperado al actualizar el estado.")
    router.add(["POST"], "/api/people", _create_person, modules=P,
               error_msg="Error inesperado al crear el usuario.")
    router.add(["PATCH", "DELETE"], "/api/people/{personId}", _person_update, modules=P,
               error_msg="Error inesperado al actualizar el usuario.")
    router.add(["POST"], "/api/projects", _create_project, modules=P,
               error_msg="Error inesperado al crear el proyecto.")
    router.add(["PATCH", "DELETE"], "/api/projects/{projectId}", _project_update, modules=P,
               error_msg="Error inesperado al actualizar el proyecto.")
    router.add(["POST"], "/api/projects/{projectId}/members", _add_member, modules=P,
               error_msg="Error inesperado al agregar el usuario al proyecto.")
    router.add(["PATCH", "DELETE"], "/api/projects/{projectId}/members/{personId}", _member_update, modules=P,
               error_msg="Error inesperado al actualizar la asignación del usuario.")
    router.add(["POST"], "/api/projects/{projectId}/updates", _create_update, modules=P,
               error_msg="Error inesperado al registrar el seguimiento.")
    router.add(["PATCH", "DELETE"], "/api/projects/{projectId}/updates/{updateId}", _update_update, modules=P,
               error_msg="Error inesperado al actualizar el seguimiento.")
    router.add(["POST"], "/api/projects/{projectId}/tasks", _create_task, modules=T,
               error_msg="Error inesperado al crear la tarea.")
    router.add(["PATCH", "DELETE"], "/api/projects/{projectId}/tasks/{taskId}", _task_update, modules=T,
               error_msg="Error inesperado al actualizar la tarea.")
    router.add(["POST"], "/api/projects/{projectId}/attachments/presign", _presign_attachment, modules=P,
               error_msg="Error inesperado al preparar la subida del adjunto.")
    router.add(["POST"], "/api/projects/{projectId}/attachments", _create_attachment, modules=P,
               error_msg="Error inesperado al guardar el adjunto.")
    router.add(["GET"], "/api/projects/{projectId}/attachments/{attachmentId}/url", _attachment_url, modules=P,
               error_msg="Error inesperado al abrir el adjunto.")
    router.add(["PATCH", "DELETE"], "/api/projects/{projectId}/attachments/{attachmentId}", _attachment_update, modules=P,
               error_msg="Error inesperado al actualizar el adjunto.")
