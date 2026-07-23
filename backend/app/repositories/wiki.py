from typing import Any

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository


class WikiRepository(BaseRepository):
    """Páginas de la Wiki + su historial de revisiones (append-only).

    WIKI_PAGE  PK=WIKI#<pageId>  SK=META            (estado actual)
    WIKI_REV   PK=WIKI#<pageId>  SK=REV#<ts>#<revId> (snapshot ANTERIOR a cada
               edición — el orden natural del SK deja la más reciente al final)
    """

    def _pk(self, page_id: str) -> str:
        return f"WIKI#{page_id}"

    # ── Páginas ───────────────────────────────────────────────────────────────
    def list_pages(self) -> list[dict[str, Any]]:
        return self._query_entity_type("WIKI_PAGE")

    def get_page(self, page_id: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": self._pk(page_id), "SK": "META"}).get("Item")

    def put_page(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)

    def update_page(self, page_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": self._pk(page_id), "SK": "META"}, values)

    def delete_page(self, page_id: str) -> None:
        """Borra la página Y todo su historial (todos los items del PK)."""
        items = self._query_all(KeyConditionExpression=Key("PK").eq(self._pk(page_id)))
        with self._table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

    # ── Marcador de la limpieza de imágenes huérfanas (throttle diario) ───────
    def get_cleanup_marker(self) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": "WIKI#CLEANUP", "SK": "META"}).get("Item")

    def put_cleanup_marker(self, started_at: str) -> None:
        self._table.put_item(Item={
            "PK": "WIKI#CLEANUP", "SK": "META", "entityType": "WIKI_META",
            "startedAt": started_at,
        })

    # ── Revisiones ────────────────────────────────────────────────────────────
    def put_revision(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)

    def list_revisions(self, page_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(self._pk(page_id)) & Key("SK").begins_with("REV#"))

    def get_revision(self, page_id: str, rev_sk: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": self._pk(page_id), "SK": rev_sk}).get("Item")
