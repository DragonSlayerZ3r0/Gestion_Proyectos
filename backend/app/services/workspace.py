import re
import unicodedata
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from core.errors import ValidationError  # re-exportado para compatibilidad
from repositories.workspace import WorkspaceRepository
from services.attachments import AttachmentService
from services.name_directory import NameDirectory


# ── Catálogos de valores: FUENTE ÚNICA {key, label} (regla 2026-07-09) ────────
# Agregar un valor aquí lo propaga SOLO a todo (selects de crear/editar, filtros,
# chips, columnas): get_workspace publica estos catálogos y el frontend los
# deriva — nunca escribir las opciones a mano en un <select>. Las listas de
# claves para validación se DERIVAN de aquí.
TASK_STATUSES_CATALOG = [
    {"key": "pending", "label": "Pendiente"},
    {"key": "in_progress", "label": "En progreso"},
    {"key": "review", "label": "En revisión"},
    {"key": "done", "label": "Completada"},
]
TASK_PRIORITIES_CATALOG = [
    {"key": "low", "label": "Baja"},
    {"key": "medium", "label": "Media"},
    {"key": "high", "label": "Alta"},
    {"key": "critical", "label": "Crítica"},
]
REQUEST_TYPES_CATALOG = [
    {"key": "project", "label": "Proyecto"},
    {"key": "report", "label": "Reporte"},
    {"key": "requirement", "label": "Requerimiento"},
]
PERSON_STATUSES_CATALOG = [
    {"key": "active", "label": "Activo"},
    {"key": "inactive", "label": "Inactivo"},
]
TASK_STATUSES = [t["key"] for t in TASK_STATUSES_CATALOG]
TASK_PRIORITIES = [t["key"] for t in TASK_PRIORITIES_CATALOG]
PROJECT_STATUSES = ["planned", "active", "paused", "closed"]
# Paleta fija de colores para los estados (legibles y coherentes con la app; sin un
# rojo "de peligro" salvo el histórico "closed"). El catálogo guarda solo la clave.
STATUS_COLORS = ["blue", "green", "amber", "rose", "slate", "teal", "purple", "orange"]
# Estados semilla = los 4 actuales (misma clave → sin migrar solicitudes existentes).
_DEFAULT_STATUSES = [
    ("planned", "Planificado", "blue", 1),
    ("active", "Activo", "green", 2),
    ("paused", "Pausado", "amber", 3),
    ("closed", "Cerrado", "rose", 4),
]
# Tipo de la solicitud (el módulo se muestra como "Solicitudes"; la clave interna
# sigue siendo projects/PROJECT# — solo cambió la etiqueta, regla del proyecto).
REQUEST_TYPES = [t["key"] for t in REQUEST_TYPES_CATALOG]
PERSON_STATUSES = [t["key"] for t in PERSON_STATUSES_CATALOG]
PROJECT_MEMBER_ROLES = ["owner", "member", "reader"]
TASK_AUDIT_FIELDS = ["status", "priority", "assigneePersonId"]
UPDATE_MAX_CHARS = 2000
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Guatemala (UTC-6, sin horario de verano): la "fecha de hoy" del seguimiento debe
# ser la del usuario, no la UTC (que cambia de día a las 6 pm hora local).
_TZ_GT = timezone(timedelta(hours=-6))

__all__ = ["WorkspaceService", "ValidationError", "TASK_STATUSES", "TASK_PRIORITIES",
           "PROJECT_STATUSES", "PERSON_STATUSES", "PROJECT_MEMBER_ROLES"]


class WorkspaceService:
    def __init__(self, repository: WorkspaceRepository | None = None) -> None:
        self._repository = repository or WorkspaceRepository()

    def get_workspace(self) -> dict[str, Any]:
        people = [self._normalize_person(item) for item in self._repository.list_people()]
        projects = [self._normalize_project(item) for item in self._repository.list_projects()]

        # Sin N+1: miembros, tareas y seguimientos de TODOS los proyectos llegan
        # en un viaje por tipo (GSI byEntityType) y se agrupan aquí por projectId
        # (antes eran 3 consultas por proyecto: el "Guardar" y la carga inicial
        # se sentían lentos por esto).
        members_by: dict[str, list] = {}
        for item in self._repository.list_all_members():
            members_by.setdefault(item.get("projectId", ""), []).append(self._normalize_member(item))
        tasks_by: dict[str, list] = {}
        for item in self._repository.list_all_tasks_full():
            tasks_by.setdefault(item.get("projectId", ""), []).append(self._normalize_task(item))
        updates_by: dict[str, list] = {}
        all_updates: list[dict[str, Any]] = []
        for item in self._repository.list_all_updates():
            update = self._normalize_update(item)
            updates_by.setdefault(item.get("projectId", ""), []).append(update)
            all_updates.append(update)
        # Adjuntos (archivos S3 + queries) agrupados por solicitud, mismo viaje único.
        attach_service = AttachmentService(self._repository)
        attachments_by: dict[str, list] = {}
        all_attachments: list[dict[str, Any]] = []
        for item in self._repository.list_all_attachments():
            att = attach_service.normalize(item)
            attachments_by.setdefault(item.get("projectId", ""), []).append(att)
            all_attachments.append(att)

        # Autor legible (createdBy correo → nombre): se resuelve UNA vez para
        # seguimientos y adjuntos juntos (caché compartida con Athena). Sin autores,
        # no se toca Identity Center ni la caché.
        authors = [u["createdBy"] for u in all_updates if u["createdBy"]]
        authors += [a["createdBy"] for a in all_attachments if a["createdBy"]]
        if authors:
            names = NameDirectory().resolve(authors)
            for update in all_updates:
                update["createdByName"] = names.get(update["createdBy"], "")
            for att in all_attachments:
                att["createdByName"] = names.get(att["createdBy"], "")

        for project in projects:
            project["members"] = members_by.get(project["id"], [])
            project["tasks"] = tasks_by.get(project["id"], [])
            # Seguimiento: lo más reciente primero (fecha del trabajo; a igual fecha,
            # lo anotado más tarde arriba).
            project["updates"] = sorted(
                updates_by.get(project["id"], []),
                key=lambda u: (u["date"], u["createdAt"]), reverse=True)
            # Adjuntos: lo más reciente primero.
            project["attachments"] = sorted(
                attachments_by.get(project["id"], []),
                key=lambda a: a["createdAt"], reverse=True)

        return {
            "areas": sorted((self._normalize_area(item) for item in self._repository.list_areas()),
                            key=lambda area: area["name"].lower()),
            "projectStatuses": self.list_project_statuses(),
            "statusColors": STATUS_COLORS,
            "people": sorted(people, key=lambda person: person["fullName"].lower()),
            "projects": sorted(projects, key=lambda project: project["updatedAt"], reverse=True),
            "taskStatuses": TASK_STATUSES_CATALOG,
            "taskPriorities": TASK_PRIORITIES_CATALOG,
            "requestTypes": REQUEST_TYPES_CATALOG,
            "personStatuses": PERSON_STATUSES_CATALOG
        }

    @staticmethod
    def _norm_name(value: str) -> str:
        """Nombre comparable: minúsculas, sin acentos ni espacios repetidos — para
        detectar duplicados como "carlos urizar" vs "Carlos Urízar"."""
        flat = unicodedata.normalize("NFD", value or "")
        flat = "".join(c for c in flat if unicodedata.category(c) != "Mn")
        return " ".join(flat.lower().split())

    def create_area(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        name = self._required_text(payload, "name", "Nombre del área solicitante")
        self._ensure_area_name_free(name)
        now = self._now()
        area_id = uuid4().hex
        item = {
            "PK": f"AREA#{area_id}",
            "SK": "PROFILE",
            "entityType": "AREA",
            "areaId": area_id,
            "name": name,
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"]
        }
        self._repository.put_item(item)
        return self._normalize_area(item)

    def update_area(self, area_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        # Editable a propósito: si el área se registró con un error de escritura,
        # se corrige aquí y todas las solicitudes que la referencian (por id)
        # muestran el nombre corregido sin migrar nada.
        area_id = self._required_text({"areaId": area_id}, "areaId", "Área solicitante")
        name = self._required_text(payload, "name", "Nombre del área solicitante")
        self._ensure_area_name_free(name, exclude_id=area_id)
        values = {
            "name": name,
            "updatedAt": self._now(),
            "updatedBy": identity["userId"]
        }
        return self._normalize_area(self._repository.update_area(area_id, values))

    def delete_area(self, area_id: str, identity: dict[str, str]) -> dict[str, Any]:
        area_id = self._required_text({"areaId": area_id}, "areaId", "Área solicitante")
        # Impedir y avisar (igual que estados): el catálogo es compartido por los
        # campos "Área solicitante" y "Grupo de trabajo" — se cuentan ambos usos.
        in_use = sum(1 for p in self._repository.list_projects()
                     if p.get("requestingAreaId") == area_id or p.get("targetAreaId") == area_id)
        if in_use:
            raise ValidationError(
                f"No se puede eliminar: {in_use} solicitud(es) usan esta área "
                "(como área solicitante o grupo de trabajo). Reasígnalas antes de eliminarla.")
        self._repository.delete_area(area_id)
        return {"areaId": area_id, "removed": True}

    def _ensure_area_name_free(self, name: str, exclude_id: str = "") -> None:
        name_norm = self._norm_name(name)
        for existing in self._repository.list_areas():
            if existing.get("areaId") == exclude_id:
                continue
            if self._norm_name(existing.get("name", "")) == name_norm:
                raise ValidationError(
                    f"Ya existe el área solicitante \"{existing.get('name')}\". "
                    "Selecciónala de la lista o edítala si el nombre tiene un error.")

    # ── Estados de solicitud (catálogo vivo: etiqueta + color de una paleta) ──
    def list_project_statuses(self) -> list[dict[str, Any]]:
        items = self._repository.list_statuses()
        if not items:
            items = self._seed_default_statuses()
        return sorted((self._normalize_status(i) for i in items),
                      key=lambda s: (s["order"], s["label"].lower()))

    def _seed_default_statuses(self) -> list[dict[str, Any]]:
        """Primera vez: materializa los 4 estados actuales como items reales (para
        que se puedan editar/borrar). Ids = claves actuales → las solicitudes ya
        guardadas (status="active"…) siguen calzando sin migración."""
        now = self._now()
        items = []
        for key, label, color, order in _DEFAULT_STATUSES:
            item = {
                "PK": f"STATUS#{key}", "SK": "PROFILE", "entityType": "PROJECT_STATUS",
                "statusId": key, "label": label, "color": color, "order": order,
                "createdAt": now, "updatedAt": now,
            }
            self._repository.put_item(item)
            items.append(item)
        return items

    def create_status(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        self.list_project_statuses()  # asegura semilla antes del primer alta manual
        label = self._required_text(payload, "label", "Nombre del estado")
        color = self._allowed(payload.get("color") or "slate", STATUS_COLORS, "Color del estado")
        self._ensure_status_label_free(label)
        existing = self._repository.list_statuses()
        order = max((int(s.get("order", 0)) for s in existing), default=0) + 1
        now = self._now()
        status_id = uuid4().hex
        item = {
            "PK": f"STATUS#{status_id}", "SK": "PROFILE", "entityType": "PROJECT_STATUS",
            "statusId": status_id, "label": label, "color": color, "order": order,
            "createdAt": now, "updatedAt": now,
            "createdBy": identity["userId"], "updatedBy": identity["userId"],
        }
        self._repository.put_item(item)
        return self._normalize_status(item)

    def update_status(self, status_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        status_id = self._required_text({"statusId": status_id}, "statusId", "Estado")
        self.list_project_statuses()
        values: dict[str, Any] = {"updatedAt": self._now(), "updatedBy": identity["userId"]}
        if "label" in payload:
            label = self._required_text(payload, "label", "Nombre del estado")
            self._ensure_status_label_free(label, exclude_id=status_id)
            values["label"] = label
        if "color" in payload:
            values["color"] = self._allowed(payload["color"], STATUS_COLORS, "Color del estado")
        return self._normalize_status(self._repository.update_status(status_id, values))

    def delete_status(self, status_id: str, identity: dict[str, str]) -> dict[str, Any]:
        status_id = self._required_text({"statusId": status_id}, "statusId", "Estado")
        # Impedir y avisar: no dejar solicitudes con un estado fantasma.
        in_use = sum(1 for p in self._repository.list_projects() if p.get("status") == status_id)
        if in_use:
            raise ValidationError(
                f"No se puede eliminar: {in_use} solicitud(es) usan este estado. "
                "Reasígnalas a otro estado antes de eliminarlo.")
        self._repository.delete_status(status_id)
        return {"statusId": status_id, "removed": True}

    def _ensure_status_label_free(self, label: str, exclude_id: str = "") -> None:
        label_norm = self._norm_name(label)
        for existing in self._repository.list_statuses():
            if existing.get("statusId") == exclude_id:
                continue
            if self._norm_name(existing.get("label", "")) == label_norm:
                raise ValidationError(
                    f"Ya existe el estado \"{existing.get('label')}\". "
                    "Selecciónalo de la lista o edítalo si el nombre tiene un error.")

    def _valid_status(self, value: Any) -> str:
        """Estado opcional; si viene, debe existir en el catálogo."""
        status_id = str(value or "").strip()
        if not status_id:
            return ""
        if not any(s["id"] == status_id for s in self.list_project_statuses()):
            raise ValidationError("El estado seleccionado ya no existe. Recarga y vuelve a intentarlo.")
        return status_id

    def _normalize_status(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item["statusId"],
            "label": item.get("label", ""),
            "color": item.get("color", "slate"),
            "order": int(item.get("order", 0)),
        }

    def create_person(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        # Un SOLO campo de nombre (firstName): puede ser nombre, nombre y apellido,
        # nombre completo o el nombre de un proveedor. lastName queda opcional/vacío
        # (la UI ya no lo pide); fullName = lo que se escribió.
        first_name = self._required_text(payload, "firstName", "Nombre")
        last_name = self._optional_text(payload, "lastName")
        full_name = f"{first_name} {last_name}".strip()
        # Evita duplicados accidentales (mismo nombre, ignorando mayúsculas/acentos).
        # Si es un homónimo real, diferéncialo — mensaje claro en vez de registrar
        # silenciosamente.
        full_norm = self._norm_name(full_name)
        for existing in self._repository.list_people():
            if self._norm_name(existing.get("fullName", "")) == full_norm:
                raise ValidationError(
                    f"Ya existe una persona registrada como \"{existing.get('fullName')}\". "
                    "Si es otra, agrega el apellido o el área para diferenciarla.")
        now = self._now()
        person_id = uuid4().hex
        item = {
            "PK": f"PERSON#{person_id}",
            "SK": "PROFILE",
            "entityType": "PERSON",
            "personId": person_id,
            "firstName": first_name,
            "lastName": last_name,
            "fullName": full_name,
            "area": self._optional_text(payload, "area"),
            "notes": self._optional_text(payload, "notes"),
            "availabilityNotes": self._optional_text(payload, "availabilityNotes"),
            "status": self._allowed_optional(payload.get("status"), PERSON_STATUSES, "Estado de la persona"),
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"]
        }
        self._repository.put_item(item)
        return self._normalize_person(item)

    def create_project(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        name = self._required_text(payload, "name", "Nombre del proyecto")
        now = self._now()
        project_id = uuid4().hex
        item = {
            "PK": f"PROJECT#{project_id}",
            "SK": "META",
            "entityType": "PROJECT",
            "projectId": project_id,
            "name": name,
            "status": self._valid_status(payload.get("status")),
            "requestType": self._allowed_optional(payload.get("requestType"), REQUEST_TYPES, "Tipo de la solicitud"),
            "requestingAreaId": self._valid_area_id(payload.get("requestingAreaId")),
            "targetAreaId": self._valid_area_id(payload.get("targetAreaId")),
            "requestDate": self._optional_date(payload.get("requestDate"), "Fecha de solicitud"),
            "dueDate": self._optional_date(payload.get("dueDate"), "Fecha de entrega"),
            "progress": self._optional_progress(payload.get("progress")),
            "ownerPersonId": self._optional_text(payload, "ownerPersonId"),
            "description": self._optional_text(payload, "description"),
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"]
        }
        self._repository.put_item(item)
        project = self._normalize_project(item)
        project["members"] = []
        project["tasks"] = []
        return project

    def add_project_member(self, project_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        person_id = self._required_text(payload, "personId", "Persona")
        now = self._now()
        item = {
            "PK": f"PROJECT#{project_id}",
            "SK": f"PERSON#{person_id}",
            "entityType": "PROJECT_MEMBER",
            "projectId": project_id,
            "personId": person_id,
            "role": payload.get("role") or "member",
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"]
        }
        self._repository.put_item(item)
        return self._normalize_member(item)

    def update_person(self, person_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        values: dict[str, Any] = {
            "updatedAt": self._now(),
            "updatedBy": identity["userId"]
        }
        # El formulario de detalle envía siempre firstName + lastName. Apellido
        # OPCIONAL (registro por un solo nombre, p. ej. proveedores); recomputamos
        # el nombre completo desde el payload.
        if "firstName" in payload or "lastName" in payload:
            first_name = self._required_text(payload, "firstName", "Nombre")
            last_name = self._optional_text(payload, "lastName")
            values["firstName"] = first_name
            values["lastName"] = last_name
            values["fullName"] = f"{first_name} {last_name}".strip()
        if "area" in payload:
            values["area"] = self._optional_text(payload, "area")
        if "notes" in payload:
            values["notes"] = self._optional_text(payload, "notes")
        if "availabilityNotes" in payload:
            values["availabilityNotes"] = self._optional_text(payload, "availabilityNotes")
        if "status" in payload:
            values["status"] = self._allowed_optional(payload["status"], PERSON_STATUSES, "Estado de la persona")

        return self._normalize_person(self._repository.update_person(person_id, values))

    def update_project(self, project_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        values: dict[str, Any] = {
            "updatedAt": self._now(),
            "updatedBy": identity["userId"]
        }
        if "name" in payload:
            values["name"] = self._required_text(payload, "name", "Nombre del proyecto")
        if "description" in payload:
            values["description"] = self._optional_text(payload, "description")
        if "status" in payload:
            values["status"] = self._valid_status(payload["status"])
        if "requestType" in payload:
            values["requestType"] = self._allowed_optional(payload["requestType"], REQUEST_TYPES, "Tipo de la solicitud")
        if "requestingAreaId" in payload:
            values["requestingAreaId"] = self._valid_area_id(payload["requestingAreaId"])
        if "targetAreaId" in payload:
            values["targetAreaId"] = self._valid_area_id(payload["targetAreaId"])
        if "requestDate" in payload:
            values["requestDate"] = self._optional_date(payload.get("requestDate"), "Fecha de solicitud")
        if "dueDate" in payload:
            values["dueDate"] = self._optional_date(payload.get("dueDate"), "Fecha de entrega")
        if "progress" in payload:
            values["progress"] = self._optional_progress(payload.get("progress"))
        if "ownerPersonId" in payload:
            values["ownerPersonId"] = self._optional_text(payload, "ownerPersonId")

        project = self._normalize_project(self._repository.update_project(project_id, values))
        project["members"] = [self._normalize_member(item) for item in self._repository.list_project_members(project_id)]
        project["tasks"] = [self._normalize_task(item) for item in self._repository.list_project_tasks(project_id)]
        return project

    def update_project_member(self, project_id: str, person_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        role = self._allowed(payload.get("role") or "member", PROJECT_MEMBER_ROLES, "Rol de la persona")
        values = {
            "updatedAt": self._now(),
            "updatedBy": identity["userId"]
        }
        return self._normalize_member(self._repository.update_project_member_role(project_id, person_id, role, values))

    def remove_project_member(self, project_id: str, person_id: str, identity: dict[str, str]) -> dict[str, Any]:
        project_id = self._required_text({"projectId": project_id}, "projectId", "Proyecto")
        person_id = self._required_text({"personId": person_id}, "personId", "Persona")

        project = self._repository.get_project(project_id) or {}
        if project.get("ownerPersonId") == person_id:
            self._repository.update_project(project_id, {
                "ownerPersonId": "",
                "updatedAt": self._now(),
                "updatedBy": identity["userId"]
            })

        self._repository.delete_project_member(project_id, person_id)
        return {
            "projectId": project_id,
            "personId": person_id,
            "removed": True
        }

    def delete_person(self, person_id: str, identity: dict[str, str]) -> dict[str, Any]:
        person_id = self._required_text({"personId": person_id}, "personId", "Persona")
        # Quitar a la persona de todos los proyectos donde sea miembro u owner.
        for member in self._repository.list_member_projects(person_id):
            project_id = member.get("projectId") or str(member.get("PK", "")).split("PROJECT#", 1)[-1]
            project = self._repository.get_project(project_id) or {}
            if project.get("ownerPersonId") == person_id:
                self._repository.update_project(project_id, {
                    "ownerPersonId": "",
                    "updatedAt": self._now(),
                    "updatedBy": identity["userId"],
                })
            self._repository.delete_project_member(project_id, person_id)
        self._repository.delete_person(person_id)
        return {"personId": person_id, "removed": True}

    def delete_project(self, project_id: str, identity: dict[str, str]) -> dict[str, Any]:
        project_id = self._required_text({"projectId": project_id}, "projectId", "Proyecto")
        # Borrar los binarios de S3 de sus adjuntos antes de eliminar los items
        # (delete_project borra todos los hijos por PK, pero no toca S3).
        attach_service = AttachmentService(self._repository)
        for att in self._repository.list_project_attachments(project_id):
            if att.get("kind") == "file" and att.get("storageKey"):
                attach_service._delete_object(att["storageKey"])
        self._repository.delete_project(project_id)
        return {"projectId": project_id, "removed": True}

    def delete_task(self, project_id: str, task_id: str, identity: dict[str, str]) -> dict[str, Any]:
        project_id = self._required_text({"projectId": project_id}, "projectId", "Proyecto")
        task_id = self._required_text({"taskId": task_id}, "taskId", "Tarea")
        self._repository.delete_task(project_id, task_id)
        return {"projectId": project_id, "taskId": task_id, "removed": True}

    def _optional_progress(self, value: Any) -> Any:
        """% de avance MANUAL de la solicitud (0-100, entero); "" = sin definir.
        Es la opinión del responsable (como en los informes ejecutivos); el
        derivado de tareas se muestra aparte como sugerencia, no lo pisa."""
        raw = str(value if value is not None else "").strip()
        if raw == "":
            return ""
        try:
            pct = int(raw)
        except ValueError:
            raise ValidationError("El % de avance debe ser un número entero entre 0 y 100.")
        if pct < 0 or pct > 100:
            raise ValidationError("El % de avance debe estar entre 0 y 100.")
        return pct

    def _optional_date(self, value: Any, label: str) -> str:
        """Fecha opcional AAAA-MM-DD (la que envía <input type=date>); "" si viene vacía."""
        value = str(value or "").strip()
        if not value:
            return ""
        if not _DATE_RE.match(value):
            raise ValidationError(f"{label} debe tener formato AAAA-MM-DD.")
        try:
            datetime.fromisoformat(value)
        except ValueError:
            raise ValidationError(f"{label} no es una fecha válida.")
        return value

    # ── Seguimiento (bitácora): qué se trabajó cada día en el proyecto ─────────
    def _validate_update_date(self, value: str) -> str:
        value = (value or "").strip()
        if not _DATE_RE.match(value):
            raise ValidationError("La fecha del seguimiento debe tener formato AAAA-MM-DD.")
        try:
            datetime.fromisoformat(value)
        except ValueError:
            raise ValidationError("La fecha del seguimiento no es válida.")
        return value

    def create_project_update(self, project_id: str, payload: dict[str, Any],
                              identity: dict[str, str]) -> dict[str, Any]:
        """Nueva entrada de seguimiento. La fecha se asigna sola (HOY en hora de
        Guatemala); si viene en el payload se respeta (p. ej. anotar lo del viernes
        un lunes). El texto es editable después, igual que la fecha."""
        project_id = self._required_text({"projectId": project_id}, "projectId", "Proyecto")
        if not self._repository.get_project(project_id):
            raise ValidationError("El proyecto no existe.")
        text = self._required_text(payload, "text", "Texto del seguimiento")
        if len(text) > UPDATE_MAX_CHARS:
            raise ValidationError(f"El seguimiento supera el máximo de {UPDATE_MAX_CHARS} caracteres.")
        date = (payload.get("date") or "").strip() or datetime.now(_TZ_GT).strftime("%Y-%m-%d")
        date = self._validate_update_date(date)
        now = self._now()
        update_id = uuid4().hex
        item = {
            "PK": f"PROJECT#{project_id}",
            "SK": f"UPDATE#{update_id}",
            "entityType": "PROJECT_UPDATE",
            "projectId": project_id,
            "updateId": update_id,
            "date": date,
            "text": text,
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"],
        }
        self._repository.put_item(item)
        update = self._normalize_update(item)
        # Nombre del autor listo desde ya (así la entrada recién creada no muestra
        # el correo hasta la próxima recarga completa).
        update["createdByName"] = NameDirectory().resolve([update["createdBy"]]).get(update["createdBy"], "")
        return update

    def update_project_update(self, project_id: str, update_id: str, payload: dict[str, Any],
                              identity: dict[str, str]) -> dict[str, Any]:
        """Edita texto y/o fecha de una entrada (para corregir lo mal anotado)."""
        if not self._repository.get_project_update(project_id, update_id):
            raise ValidationError("La entrada de seguimiento no existe.")
        values: dict[str, Any] = {"updatedAt": self._now(), "updatedBy": identity["userId"]}
        if "text" in payload:
            text = self._required_text(payload, "text", "Texto del seguimiento")
            if len(text) > UPDATE_MAX_CHARS:
                raise ValidationError(f"El seguimiento supera el máximo de {UPDATE_MAX_CHARS} caracteres.")
            values["text"] = text
        if "date" in payload:
            values["date"] = self._validate_update_date(payload.get("date") or "")
        update = self._normalize_update(self._repository.update_project_update(project_id, update_id, values))
        # El autor no cambia al editar, pero se resuelve para no perder el nombre
        # en el merge del frontend (createdBy se conserva en el item).
        update["createdByName"] = NameDirectory().resolve([update["createdBy"]]).get(update["createdBy"], "")
        return update

    def delete_project_update(self, project_id: str, update_id: str,
                              identity: dict[str, str]) -> dict[str, Any]:
        self._repository.delete_project_update(project_id, update_id)
        return {"projectId": project_id, "updateId": update_id, "removed": True}

    def create_task(self, project_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        title = self._required_text(payload, "title", "Título de la tarea")
        now = self._now()
        task_id = uuid4().hex
        item = {
            "PK": f"PROJECT#{project_id}",
            "SK": f"TASK#{task_id}",
            "entityType": "TASK",
            "projectId": project_id,
            "taskId": task_id,
            "title": title,
            "status": self._allowed(payload.get("status") or "pending", TASK_STATUSES, "Estado de la tarea"),
            "priority": self._allowed_optional(payload.get("priority"), TASK_PRIORITIES, "Prioridad"),
            "assigneePersonId": self._optional_text(payload, "assigneePersonId"),
            "notes": self._optional_text(payload, "notes"),
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"]
        }
        self._repository.put_item(item)
        return self._normalize_task(item)

    def update_task(self, project_id: str, task_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        existing_task = self._repository.get_task(project_id, task_id) or {}
        values: dict[str, Any] = {
            "updatedAt": self._now(),
            "updatedBy": identity["userId"]
        }
        if "status" in payload:
            values["status"] = self._allowed(payload["status"], TASK_STATUSES, "Estado de la tarea")
        if "priority" in payload:
            values["priority"] = self._allowed_optional(payload["priority"], TASK_PRIORITIES, "Prioridad")
        if "assigneePersonId" in payload:
            values["assigneePersonId"] = self._optional_text(payload, "assigneePersonId")
        if "title" in payload:
            values["title"] = self._required_text(payload, "title", "Título de la tarea")
        if "notes" in payload:
            values["notes"] = self._optional_text(payload, "notes")

        updated_task = self._repository.update_task(project_id, task_id, values)
        self._audit_task_changes(project_id, task_id, existing_task, updated_task, identity)
        return self._normalize_task(updated_task)

    def _valid_area_id(self, value: Any) -> str:
        """Área opcional, pero si viene debe existir en el catálogo (prevención de
        errores: no aceptar ids huérfanos que dejarían la solicitud sin área visible)."""
        area_id = str(value or "").strip()
        if not area_id:
            return ""
        if not any(item.get("areaId") == area_id for item in self._repository.list_areas()):
            raise ValidationError("El área solicitante seleccionada ya no existe. Recarga y vuelve a intentarlo.")
        return area_id

    def _normalize_area(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item["areaId"],
            "name": item.get("name", ""),
            "updatedAt": item.get("updatedAt", "")
        }

    def _normalize_person(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item["personId"],
            "firstName": item.get("firstName", ""),
            "lastName": item.get("lastName", ""),
            "fullName": item.get("fullName") or f"{item.get('firstName', '')} {item.get('lastName', '')}".strip(),
            "area": item.get("area", ""),
            "notes": item.get("notes", ""),
            "availabilityNotes": item.get("availabilityNotes", ""),
            "status": item.get("status", ""),
            "updatedAt": item.get("updatedAt", "")
        }

    def _normalize_project(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item["projectId"],
            "name": item.get("name", ""),
            "status": item.get("status", ""),
            "requestType": item.get("requestType", ""),
            "requestingAreaId": item.get("requestingAreaId", ""),
            "targetAreaId": item.get("targetAreaId", ""),
            "requestDate": item.get("requestDate", ""),
            "dueDate": item.get("dueDate", ""),
            "progress": item.get("progress", "") if item.get("progress", "") == "" else int(item.get("progress")),
            "ownerPersonId": item.get("ownerPersonId", ""),
            "description": item.get("description", ""),
            "updatedAt": item.get("updatedAt", ""),
            "members": [],
            "tasks": [],
            "updates": [],
            "attachments": []
        }

    def _normalize_update(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item["updateId"],
            "projectId": item["projectId"],
            "date": item.get("date", ""),
            "text": item.get("text", ""),
            "createdBy": item.get("createdBy", ""),     # correo del autor
            "createdByName": "",                        # nombre legible (se resuelve en get_workspace)
            "createdAt": item.get("createdAt", ""),
            "updatedAt": item.get("updatedAt", ""),
        }

    def _normalize_member(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "projectId": item["projectId"],
            "personId": item["personId"],
            "role": item.get("role", "member"),
            "updatedAt": item.get("updatedAt", "")
        }

    def _normalize_task(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item["taskId"],
            "projectId": item["projectId"],
            "title": item.get("title", ""),
            "status": item.get("status", "pending"),
            "priority": item.get("priority", ""),
            "assigneePersonId": item.get("assigneePersonId", ""),
            "notes": item.get("notes", ""),
            "updatedAt": item.get("updatedAt", "")
        }

    def _required_text(self, payload: dict[str, Any], key: str, label: str) -> str:
        value = str(payload.get(key) or "").strip()
        if not value:
            raise ValidationError(f"{label} es obligatorio.")
        return value

    def _optional_text(self, payload: dict[str, Any], key: str) -> str:
        return str(payload.get(key) or "").strip()

    def _allowed(self, value: str, allowed_values: list[str], label: str) -> str:
        normalized = str(value or "").strip()
        if normalized not in allowed_values:
            raise ValidationError(f"{label} no es válido.")
        return normalized

    def _allowed_optional(self, value: str | None, allowed_values: list[str], label: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            return ""
        if normalized not in allowed_values:
            raise ValidationError(f"{label} no es válido.")
        return normalized

    def _now(self) -> str:
        return datetime.now(UTC).isoformat()

    def _audit_task_changes(
        self,
        project_id: str,
        task_id: str,
        before: dict[str, Any],
        after: dict[str, Any],
        identity: dict[str, str]
    ) -> None:
        changed_fields = [
            field for field in TASK_AUDIT_FIELDS
            if field in after and before.get(field, "") != after.get(field, "")
        ]
        if not changed_fields:
            return

        now = self._now()
        self._repository.put_audit_event({
            "PK": f"AUDIT#{now[:10]}",
            "SK": f"{now}#{uuid4().hex}",
            "entityType": "AUDIT_EVENT",
            "eventType": "TASK_UPDATED",
            "projectId": project_id,
            "taskId": task_id,
            "changedFields": changed_fields,
            "createdAt": now,
            "createdBy": identity["userId"]
        })
