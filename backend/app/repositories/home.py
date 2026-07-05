from typing import Any

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository


class HomeRepository(BaseRepository):
    """Caché de costos del dashboard de Inicio. Los resúmenes operativos y de
    catálogo se leen vía WorkspaceRepository y CatalogRepository."""

    def get_cost_cache(self, key: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": "HOME#COSTS", "SK": key})
        return response.get("Item")

    def delete_cost_cache_prefix(self, prefix: str) -> None:
        """Borra todas las entradas de caché de un periodo (principal + diario +
        detalles por servicio), cuyas SK comparten el prefijo cuenta#inicio#fin."""
        items = self._query_all(
            KeyConditionExpression=Key("PK").eq("HOME#COSTS") & Key("SK").begins_with(prefix)
        )
        with self._table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

    def put_cost_cache(self, key: str, data: dict[str, Any], fetched_at: str) -> None:
        self._table.put_item(Item={
            "PK": "HOME#COSTS", "SK": key,
            "entityType": "HOME_COSTS",
            "data": data, "fetchedAt": fetched_at,
        })
