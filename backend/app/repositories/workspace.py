from typing import Any

from boto3.dynamodb.conditions import Attr, Key

from repositories.base import BaseRepository


class WorkspaceRepository(BaseRepository):
    """Personas, proyectos, miembros y tareas."""

    # ── Versión del espacio de trabajo (para refresco en vivo, 2026-07-28) ────
    # UN item contador que se incrementa en CADA escritura. El frontend sondea
    # `get_version` (lectura de 1 item, ~50 ms y unos bytes) y solo baja el
    # workspace COMPLETO (~180 KB, ~1.4 s) cuando el número cambió. Sondear el
    # workspace entero cada pocos segundos por usuario sería caro y lento; esto
    # es el mismo patrón de un ETag.
    _VERSION_KEY = {"PK": "WORKSPACE#META", "SK": "VERSION"}

    def bump_version(self) -> None:
        """Suma 1 de forma atómica (ADD). Best-effort: si fallara, el dato ya se
        guardó — solo se pierde el aviso en vivo, y el sondeo lo verá al próximo
        cambio. Nunca debe romper una escritura del usuario."""
        try:
            self._table.update_item(
                Key=self._VERSION_KEY,
                UpdateExpression="ADD #v :one SET entityType = :t",
                ExpressionAttributeNames={"#v": "version"},
                ExpressionAttributeValues={":one": 1, ":t": "WORKSPACE_META"})
        except Exception:                   # noqa: BLE001
            pass

    def get_version(self) -> int:
        response = self._table.get_item(Key=self._VERSION_KEY,
                                        ProjectionExpression="version")
        return int((response.get("Item") or {}).get("version", 0))

    # Envolturas de escritura: TODA modificación pasa por aquí y avisa (bump).
    # Un método nuevo que use estas primitivas queda cubierto solo — por eso no
    # se llama a bump_version() suelto en cada operación.
    def _delete(self, key: dict[str, str]) -> None:
        self._table.delete_item(Key=key)
        self.bump_version()

    def _update(self, key: dict[str, str], values: dict[str, Any],
                return_values: str = "ALL_NEW") -> dict[str, Any]:
        result = super()._update(key, values, return_values)
        self.bump_version()
        return result

    # ── Áreas solicitantes (catálogo vivo: quién pide la solicitud) ───────────
    def list_areas(self) -> list[dict[str, Any]]:
        return self._query_entity_type("AREA")

    def update_area(self, area_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"AREA#{area_id}", "SK": "PROFILE"}, values)

    def delete_area(self, area_id: str) -> None:
        self._delete({"PK": f"AREA#{area_id}", "SK": "PROFILE"})

    # ── Estados de solicitud (catálogo vivo: etiqueta + color) ────────────────
    def list_statuses(self) -> list[dict[str, Any]]:
        return self._query_entity_type("PROJECT_STATUS")

    def update_status(self, status_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"STATUS#{status_id}", "SK": "PROFILE"}, values)

    def delete_status(self, status_id: str) -> None:
        self._delete({"PK": f"STATUS#{status_id}", "SK": "PROFILE"})

    # ── Personas ──────────────────────────────────────────────────────────────
    def list_people(self) -> list[dict[str, Any]]:
        return self._query_entity_type("PERSON")

    def update_person(self, person_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PERSON#{person_id}", "SK": "PROFILE"}, values)

    def delete_person(self, person_id: str) -> None:
        self._delete({"PK": f"PERSON#{person_id}", "SK": "PROFILE"})

    def list_member_projects(self, person_id: str) -> list[dict[str, Any]]:
        """Proyectos donde la persona es miembro (membresías vía GSI + filtro por SK)."""
        return self._query_entity_type("PROJECT_MEMBER", Attr("SK").eq(f"PERSON#{person_id}"))

    # ── Proyectos ─────────────────────────────────────────────────────────────
    def list_projects(self) -> list[dict[str, Any]]:
        return self._query_entity_type("PROJECT")

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"PROJECT#{project_id}", "SK": "META"})
        return response.get("Item")

    def update_project(self, project_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PROJECT#{project_id}", "SK": "META"}, values)

    def delete_project(self, project_id: str) -> None:
        """Borra el proyecto y TODOS sus items hijos (META, PERSON#, TASK#, UPDATE#)."""
        items = self._query_all(KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}"))
        with self._table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
        self.bump_version()     # el lote no pasa por _delete: se avisa a mano

    # ── Miembros ──────────────────────────────────────────────────────────────
    def list_project_members(self, project_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}") & Key("SK").begins_with("PERSON#"))

    def update_project_member_role(self, project_id: str, person_id: str, role: str, values: dict[str, str]) -> dict[str, Any]:
        return self._update({"PK": f"PROJECT#{project_id}", "SK": f"PERSON#{person_id}"}, {"role": role, **values})

    def delete_project_member(self, project_id: str, person_id: str) -> None:
        self._delete({"PK": f"PROJECT#{project_id}", "SK": f"PERSON#{person_id}"})

    # ── Tareas ────────────────────────────────────────────────────────────────
    def list_project_tasks(self, project_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}") & Key("SK").begins_with("TASK#"))

    def get_task(self, project_id: str, task_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"PROJECT#{project_id}", "SK": f"TASK#{task_id}"})
        return response.get("Item")

    def update_task(self, project_id: str, task_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PROJECT#{project_id}", "SK": f"TASK#{task_id}"}, values)

    def delete_task(self, project_id: str, task_id: str) -> None:
        self._delete({"PK": f"PROJECT#{project_id}", "SK": f"TASK#{task_id}"})

    # ── Entregables (2026-07-31) ──────────────────────────────────────────────
    # Nivel OPCIONAL entre la solicitud y sus tareas: agrupa el trabajo de las
    # solicitudes grandes (las de 12-15 tareas). Mismo PK del proyecto → el
    # borrado de la solicitud los arrastra sin código extra, igual que tareas y
    # bitácoras. La tarea guarda `deliverableId`; sin él queda "sin entregable".
    def list_project_deliverables(self, project_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}")
            & Key("SK").begins_with("DELIV#"))

    def get_deliverable(self, project_id: str, deliverable_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={"PK": f"PROJECT#{project_id}", "SK": f"DELIV#{deliverable_id}"})
        return response.get("Item")

    def update_deliverable(self, project_id: str, deliverable_id: str,
                           values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PROJECT#{project_id}", "SK": f"DELIV#{deliverable_id}"}, values)

    def delete_deliverable(self, project_id: str, deliverable_id: str) -> None:
        self._delete({"PK": f"PROJECT#{project_id}", "SK": f"DELIV#{deliverable_id}"})

    def list_all_deliverables(self) -> list[dict[str, Any]]:
        return self._query_entity_type("DELIVERABLE")

    # ── Seguimiento POR TAREA (bitácora de la tarea, 2026-07-24) ──────────────
    # Mismo PK del proyecto (los hijos viajan juntos y el borrado del proyecto
    # los arrastra); el SK lleva el taskId ANTES del updateId para poder listar
    # los de UNA tarea con un begins_with, sin filtros ni scans.
    def list_task_updates(self, project_id: str, task_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}")
            & Key("SK").begins_with(f"TASKUPDATE#{task_id}#"))

    def get_task_update(self, project_id: str, task_id: str, update_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={"PK": f"PROJECT#{project_id}", "SK": f"TASKUPDATE#{task_id}#{update_id}"})
        return response.get("Item")

    def update_task_update(self, project_id: str, task_id: str, update_id: str,
                           values: dict[str, Any]) -> dict[str, Any]:
        return self._update(
            {"PK": f"PROJECT#{project_id}", "SK": f"TASKUPDATE#{task_id}#{update_id}"}, values)

    def delete_task_update(self, project_id: str, task_id: str, update_id: str) -> None:
        self._delete({"PK": f"PROJECT#{project_id}", "SK": f"TASKUPDATE#{task_id}#{update_id}"})

    def delete_task_updates(self, project_id: str, task_id: str) -> list[str]:
        """Borra la bitácora completa de una tarea (al eliminar la tarea) y
        devuelve los updateId borrados para desindexar sus vectores."""
        items = self.list_task_updates(project_id, task_id)
        if not items:
            return []
        with self._table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
        self.bump_version()     # ídem: borrado en lote
        return [item.get("updateId", "") for item in items if item.get("updateId")]

    # ── Seguimiento (bitácora del proyecto) ───────────────────────────────────
    def list_project_updates(self, project_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}") & Key("SK").begins_with("UPDATE#"))

    def get_project_update(self, project_id: str, update_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"PROJECT#{project_id}", "SK": f"UPDATE#{update_id}"})
        return response.get("Item")

    def update_project_update(self, project_id: str, update_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PROJECT#{project_id}", "SK": f"UPDATE#{update_id}"}, values)

    def delete_project_update(self, project_id: str, update_id: str) -> None:
        self._delete({"PK": f"PROJECT#{project_id}", "SK": f"UPDATE#{update_id}"})

    # ── Adjuntos (archivos en S3 / queries inline) ────────────────────────────
    def get_attachment(self, project_id: str, attachment_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"PROJECT#{project_id}", "SK": f"ATTACH#{attachment_id}"})
        return response.get("Item")

    def update_attachment(self, project_id: str, attachment_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PROJECT#{project_id}", "SK": f"ATTACH#{attachment_id}"}, values)

    def delete_attachment(self, project_id: str, attachment_id: str) -> None:
        self._delete({"PK": f"PROJECT#{project_id}", "SK": f"ATTACH#{attachment_id}"})

    def list_all_attachments(self) -> list[dict[str, Any]]:
        return self._query_entity_type("ATTACHMENT")

    def list_project_attachments(self, project_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}") & Key("SK").begins_with("ATTACH#"))

    # ── Hijos de TODOS los proyectos en un viaje por tipo (GSI byEntityType) ──
    # Evita el N+1 de get_workspace (3 consultas por proyecto); el servicio
    # agrupa en memoria por projectId.
    def list_all_members(self) -> list[dict[str, Any]]:
        return self._query_entity_type("PROJECT_MEMBER")

    def list_all_tasks_full(self) -> list[dict[str, Any]]:
        return self._query_entity_type("TASK")

    def list_all_updates(self) -> list[dict[str, Any]]:
        return self._query_entity_type("PROJECT_UPDATE")

    def list_all_task_updates(self) -> list[dict[str, Any]]:
        return self._query_entity_type("TASK_UPDATE")

    def list_all_tasks(self) -> list[dict[str, Any]]:
        return self._query_entity_type(
            "TASK",
            ProjectionExpression="#s",
            ExpressionAttributeNames={"#s": "status"})

    # ── Genéricos ─────────────────────────────────────────────────────────────
    def put_item(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)
        self.bump_version()

    def put_audit_event(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)
