from typing import Any

from repositories.base import BaseRepository


class HomeRepository(BaseRepository):
    """Caché de costos del dashboard de Inicio. Los resúmenes operativos y de
    catálogo se leen vía WorkspaceRepository y CatalogRepository."""

    def get_cost_cache(self, key: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": "HOME#COSTS", "SK": key})
        return response.get("Item")

    def put_cost_cache(self, key: str, data: dict[str, Any], fetched_at: str) -> None:
        self._table.put_item(Item={
            "PK": "HOME#COSTS", "SK": key,
            "entityType": "HOME_COSTS",
            "data": data, "fetchedAt": fetched_at,
        })
