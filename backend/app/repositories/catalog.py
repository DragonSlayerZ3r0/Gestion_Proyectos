from typing import Any

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository


class CatalogRepository(BaseRepository):
    """Caché de metadata del catálogo (Glue) y contexto funcional."""

    # ── Sync meta ─────────────────────────────────────────────────────────────
    def get_catalog_sync_meta(self) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": "CATALOG#SYNC", "SK": "META"})
        return response.get("Item")

    def put_catalog_sync_meta(self, synced_at: str, status: str) -> None:
        self._table.put_item(Item={
            "PK": "CATALOG#SYNC", "SK": "META",
            "entityType": "CATALOG_SYNC", "syncedAt": synced_at, "status": status,
        })

    # ── Bases de datos ─────────────────────────────────────────────────────────
    def list_catalog_databases(self) -> list[dict[str, Any]]:
        response = self._table.query(KeyConditionExpression=Key("PK").eq("CATALOG#DB"))
        return response.get("Items", [])

    def put_catalog_database(self, database: str, table_count: int, synced_at: str, description: str = "", location: str = "", stats: dict[str, Any] | None = None) -> None:
        item = {
            "PK": "CATALOG#DB", "SK": database,
            "entityType": "CATALOG_DB",
            "database": database, "description": description,
            "tableCount": table_count, "syncedAt": synced_at,
            "location": location,
        }
        if stats is not None:
            item["stats"] = stats
        self._table.put_item(Item=item)

    # ── Tablas ────────────────────────────────────────────────────────────────
    def update_catalog_table_stats(self, database: str, table: str, stats: dict[str, Any]) -> None:
        """Actualiza solo las stats S3 de una tabla sin reescribir el resto del
        item (preserva el sync diferencial de la metadata de Glue)."""
        self._table.update_item(
            Key={"PK": f"CATALOG#{database}", "SK": f"TABLE#{table}"},
            UpdateExpression="SET #st = :st",
            ExpressionAttributeNames={"#st": "stats"},
            ExpressionAttributeValues={":st": stats},
        )

    def list_catalog_tables(self, database: str) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"CATALOG#{database}") & Key("SK").begins_with("TABLE#"),
            ProjectionExpression="#n, #db, tableType, description, columnCount, syncedAt, glueUpdatedAt, #loc, SK",
            ExpressionAttributeNames={"#n": "name", "#db": "database", "#loc": "location"},
        )
        return response.get("Items", [])

    def get_catalog_table(self, database: str, table: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"CATALOG#{database}", "SK": f"TABLE#{table}"})
        return response.get("Item")

    def put_catalog_table(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)

    def delete_catalog_table(self, database: str, table: str) -> None:
        self._table.delete_item(Key={"PK": f"CATALOG#{database}", "SK": f"TABLE#{table}"})

    # ── Contexto funcional ─────────────────────────────────────────────────────
    def get_table_context(self, database: str, table_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"TABLE#{database}#{table_name}", "SK": "CONTEXT"})
        return response.get("Item")

    def list_column_contexts(self, database: str, table_name: str) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"TABLE#{database}#{table_name}") & Key("SK").begins_with("COLUMN#")
        )
        return response.get("Items", [])

    def get_column_context(self, database: str, table_name: str, column_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"TABLE#{database}#{table_name}", "SK": f"COLUMN#{column_name}"})
        return response.get("Item")

    def put_context(self, item: dict[str, Any]) -> None:
        """Guarda un item de contexto funcional (TABLE_CONTEXT o COLUMN_CONTEXT)."""
        self._table.put_item(Item=item)
