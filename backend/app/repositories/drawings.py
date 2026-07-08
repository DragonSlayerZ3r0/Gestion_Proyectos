from typing import Any

from boto3.dynamodb.conditions import Attr, Key

from repositories.base import BaseRepository


class DrawingsRepository(BaseRepository):
    """Pizarras (Excalidraw): metadata DRAWING + invitaciones DRAWING_SHARE.
    La escena (JSON .excalidraw) vive en S3; aquí solo nombre, dueño y shares."""

    # ── Pizarras ──────────────────────────────────────────────────────────────
    def list_drawings(self) -> list[dict[str, Any]]:
        return self._query_entity_type("DRAWING")

    def get_drawing(self, drawing_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"DRAWING#{drawing_id}", "SK": "META"})
        return response.get("Item")

    def update_drawing(self, drawing_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"DRAWING#{drawing_id}", "SK": "META"}, values)

    def delete_drawing(self, drawing_id: str) -> None:
        """Borra la pizarra y TODOS sus hijos (META + SHARE#)."""
        items = self._query_all(KeyConditionExpression=Key("PK").eq(f"DRAWING#{drawing_id}"))
        with self._table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

    # ── Shares (invitaciones por usuario) ─────────────────────────────────────
    def list_drawing_shares(self, drawing_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"DRAWING#{drawing_id}") & Key("SK").begins_with("SHARE#"))

    def list_all_shares(self) -> list[dict[str, Any]]:
        return self._query_entity_type("DRAWING_SHARE")

    def list_shares_for_user(self, user_id: str) -> list[dict[str, Any]]:
        """Shares dirigidos a un usuario (pendientes + aceptados) vía GSI."""
        return self._query_entity_type("DRAWING_SHARE", Attr("userId").eq(user_id))

    def get_share(self, drawing_id: str, user_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"DRAWING#{drawing_id}", "SK": f"SHARE#{user_id}"})
        return response.get("Item")

    def update_share(self, drawing_id: str, user_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"DRAWING#{drawing_id}", "SK": f"SHARE#{user_id}"}, values)

    def delete_share(self, drawing_id: str, user_id: str) -> None:
        self._table.delete_item(Key={"PK": f"DRAWING#{drawing_id}", "SK": f"SHARE#{user_id}"})

    # ── Genérico ──────────────────────────────────────────────────────────────
    def put_item(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)
