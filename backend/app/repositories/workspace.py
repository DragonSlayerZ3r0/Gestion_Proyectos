from typing import Any

from boto3.dynamodb.conditions import Attr, Key

from repositories.base import BaseRepository


class WorkspaceRepository(BaseRepository):
    """Personas, proyectos, miembros y tareas."""

    # ── Personas ──────────────────────────────────────────────────────────────
    def list_people(self) -> list[dict[str, Any]]:
        return self._query_entity_type("PERSON")

    def update_person(self, person_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PERSON#{person_id}", "SK": "PROFILE"}, values)

    def delete_person(self, person_id: str) -> None:
        self._table.delete_item(Key={"PK": f"PERSON#{person_id}", "SK": "PROFILE"})

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

    # ── Miembros ──────────────────────────────────────────────────────────────
    def list_project_members(self, project_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}") & Key("SK").begins_with("PERSON#"))

    def update_project_member_role(self, project_id: str, person_id: str, role: str, values: dict[str, str]) -> dict[str, Any]:
        return self._update({"PK": f"PROJECT#{project_id}", "SK": f"PERSON#{person_id}"}, {"role": role, **values})

    def delete_project_member(self, project_id: str, person_id: str) -> None:
        self._table.delete_item(Key={"PK": f"PROJECT#{project_id}", "SK": f"PERSON#{person_id}"})

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
        self._table.delete_item(Key={"PK": f"PROJECT#{project_id}", "SK": f"TASK#{task_id}"})

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
        self._table.delete_item(Key={"PK": f"PROJECT#{project_id}", "SK": f"UPDATE#{update_id}"})

    def list_all_tasks(self) -> list[dict[str, Any]]:
        return self._query_entity_type(
            "TASK",
            ProjectionExpression="#s",
            ExpressionAttributeNames={"#s": "status"})

    # ── Genéricos ─────────────────────────────────────────────────────────────
    def put_item(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)

    def put_audit_event(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)
