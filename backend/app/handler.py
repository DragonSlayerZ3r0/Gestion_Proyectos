import json
from typing import Any

from auth import get_user_identity
from repositories.dynamodb import MainTableRepository
from responses import error, success
from services.users import UserNotConfiguredError, UserService
from services.workspace import ValidationError, WorkspaceService


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")
    path_parameters = event.get("pathParameters") or {}

    if method == "GET" and path == "/health":
        return success({"status": "ok"})

    if method == "GET" and path == "/api/me":
        return get_me(event)

    if path == "/api/workspace":
        return route_workspace(event, method)

    if path == "/api/people":
        return route_people(event, method)

    if path.startswith("/api/people/"):
        return route_person_update(event, method, path_parameters)

    if path == "/api/projects":
        return route_projects(event, method)

    if path.startswith("/api/projects/") and "/members/" in path:
        return route_project_member(event, method, path_parameters)

    if path.endswith("/members"):
        return route_project_members(event, method, path_parameters)

    if path.endswith("/tasks"):
        return route_project_tasks(event, method, path_parameters)

    if path.startswith("/api/projects/") and "/tasks/" in path:
        return route_task_update(event, method, path_parameters)

    if path.startswith("/api/projects/"):
        return route_project_update(event, method, path_parameters)

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


def route_workspace(event: dict[str, Any], method: str) -> dict[str, Any]:
    if method != "GET":
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["projects", "tasks"])
        data = WorkspaceService().get_workspace()
        return success(data)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al cargar el espacio de trabajo.", 500)


def route_people(event: dict[str, Any], method: str) -> dict[str, Any]:
    if method != "POST":
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["projects"])
        person = WorkspaceService().create_person(parse_body(event), identity)
        return success(person, 201)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except ValidationError as exc:
        return error("VALIDATION_ERROR", str(exc), 400)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al crear el usuario.", 500)


def route_person_update(event: dict[str, Any], method: str, path_parameters: dict[str, str]) -> dict[str, Any]:
    if method != "PATCH":
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["projects"])
        person_id = path_parameters.get("personId") or ""
        person = WorkspaceService().update_person(person_id, parse_body(event), identity)
        return success(person)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except ValidationError as exc:
        return error("VALIDATION_ERROR", str(exc), 400)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al actualizar el usuario.", 500)


def route_projects(event: dict[str, Any], method: str) -> dict[str, Any]:
    if method != "POST":
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["projects"])
        project = WorkspaceService().create_project(parse_body(event), identity)
        return success(project, 201)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except ValidationError as exc:
        return error("VALIDATION_ERROR", str(exc), 400)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al crear el proyecto.", 500)


def route_project_update(event: dict[str, Any], method: str, path_parameters: dict[str, str]) -> dict[str, Any]:
    if method != "PATCH":
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["projects"])
        project_id = path_parameters.get("projectId") or ""
        project = WorkspaceService().update_project(project_id, parse_body(event), identity)
        return success(project)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except ValidationError as exc:
        return error("VALIDATION_ERROR", str(exc), 400)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al actualizar el proyecto.", 500)


def route_project_members(event: dict[str, Any], method: str, path_parameters: dict[str, str]) -> dict[str, Any]:
    if method != "POST":
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["projects"])
        project_id = path_parameters.get("projectId") or ""
        member = WorkspaceService().add_project_member(project_id, parse_body(event), identity)
        return success(member, 201)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except ValidationError as exc:
        return error("VALIDATION_ERROR", str(exc), 400)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al agregar el usuario al proyecto.", 500)


def route_project_member(event: dict[str, Any], method: str, path_parameters: dict[str, str]) -> dict[str, Any]:
    if method not in {"PATCH", "DELETE"}:
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["projects"])
        project_id = path_parameters.get("projectId") or ""
        person_id = path_parameters.get("personId") or ""
        service = WorkspaceService()
        if method == "DELETE":
            return success(service.remove_project_member(project_id, person_id, identity))
        return success(service.update_project_member(project_id, person_id, parse_body(event), identity))
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except ValidationError as exc:
        return error("VALIDATION_ERROR", str(exc), 400)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al actualizar la asignación del usuario.", 500)


def route_project_tasks(event: dict[str, Any], method: str, path_parameters: dict[str, str]) -> dict[str, Any]:
    if method != "POST":
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["tasks"])
        project_id = path_parameters.get("projectId") or ""
        task = WorkspaceService().create_task(project_id, parse_body(event), identity)
        return success(task, 201)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except ValidationError as exc:
        return error("VALIDATION_ERROR", str(exc), 400)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al crear la tarea.", 500)


def route_task_update(event: dict[str, Any], method: str, path_parameters: dict[str, str]) -> dict[str, Any]:
    if method != "PATCH":
        return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)
    try:
        identity = get_user_identity(event)
        ensure_module_access(identity, ["tasks"])
        project_id = path_parameters.get("projectId") or ""
        task_id = path_parameters.get("taskId") or ""
        task = WorkspaceService().update_task(project_id, task_id, parse_body(event), identity)
        return success(task)
    except ValueError as exc:
        return error("UNAUTHORIZED", str(exc), 401)
    except PermissionError as exc:
        return error("FORBIDDEN", str(exc), 403)
    except ValidationError as exc:
        return error("VALIDATION_ERROR", str(exc), 400)
    except Exception:
        return error("INTERNAL_ERROR", "Error inesperado al actualizar la tarea.", 500)


def parse_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if not body:
        return {}
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValidationError("El cuerpo de la solicitud no es JSON válido.") from exc
    if not isinstance(parsed, dict):
        raise ValidationError("El cuerpo de la solicitud debe ser un objeto JSON.")
    return parsed


def ensure_module_access(identity: dict[str, str], module_keys: list[str]) -> None:
    modules = MainTableRepository().list_user_modules(identity["userId"])
    if not modules:
        raise PermissionError("No tienes permiso para usar este módulo.")

    enabled = {item.get("moduleKey") for item in modules if item.get("enabled")}
    if not any(module_key in enabled for module_key in module_keys):
        raise PermissionError("No tienes permiso para usar este módulo.")
