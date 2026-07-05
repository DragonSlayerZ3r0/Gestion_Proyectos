from typing import Any

import boto3
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
        return self._query_all(KeyConditionExpression=Key("PK").eq("CATALOG#DB"))

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
        items = self._query_all(
            KeyConditionExpression=Key("PK").eq(f"CATALOG#{database}") & Key("SK").begins_with("TABLE#"),
            ProjectionExpression="#n, #db, tableType, description, columnCount, syncedAt, glueUpdatedAt, #loc, SK",
            ExpressionAttributeNames={"#n": "name", "#db": "database", "#loc": "location"},
        )
        return items

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

    def batch_get_table_contexts(self, database: str, table_names: list[str]) -> dict[str, dict[str, Any]]:
        """Contexto funcional (SK=CONTEXT) de varias tablas, leído EN VIVO en lotes de
        100. Devuelve {nombre_tabla: item}. Al leerse en cada list_tables, la búsqueda
        por contexto siempre refleja lo último guardado — sin índice que mantener ni
        backfill (incluye las tablas que ya tienen contexto)."""
        result: dict[str, dict[str, Any]] = {}
        if not table_names:
            return result
        dynamodb = boto3.resource("dynamodb")
        prefix = f"TABLE#{database}#"
        for i in range(0, len(table_names), 100):
            chunk = table_names[i:i + 100]
            request: Any = {self._table.name: {"Keys": [{"PK": f"{prefix}{n}", "SK": "CONTEXT"} for n in chunk]}}
            while request:
                resp = dynamodb.batch_get_item(RequestItems=request)
                for it in resp.get("Responses", {}).get(self._table.name, []):
                    pk = it.get("PK", "")
                    if pk.startswith(prefix):
                        result[pk[len(prefix):]] = it
                request = resp.get("UnprocessedKeys") or None
        return result

    # ── Uso reciente (quién consultó la tabla en Athena) ───────────────────────
    # Lo escribe el escaneo del monitoreo de Athena (services/athena_monitor.py):
    # un item por tabla con los usuarios que la consultaron en la ventana.
    def get_table_usage(self, database: str, table_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"TABLE#{database}#{table_name}", "SK": "USAGE"})
        return response.get("Item")

    def put_table_usage_bulk(self, items: list[dict[str, Any]]) -> None:
        with self._table.batch_writer() as batch:
            for item in items:
                batch.put_item(Item=item)

    def list_column_contexts(self, database: str, table_name: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"TABLE#{database}#{table_name}") & Key("SK").begins_with("COLUMN#"))

    def get_column_context(self, database: str, table_name: str, column_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"TABLE#{database}#{table_name}", "SK": f"COLUMN#{column_name}"})
        return response.get("Item")

    def put_context(self, item: dict[str, Any]) -> None:
        """Guarda un item de contexto funcional (TABLE_CONTEXT o COLUMN_CONTEXT)."""
        self._table.put_item(Item=item)
