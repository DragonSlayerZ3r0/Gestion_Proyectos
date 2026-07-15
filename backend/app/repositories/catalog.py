from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository


class CatalogRepository(BaseRepository):
    """Caché de metadata del catálogo (Glue) y contexto funcional.

    Todas las llaves llevan la CUENTA AWS como namespace (varias cuentas pueden
    tener bases de datos con el mismo nombre — p. ej. arc_dev existe en el hub y
    en la cuenta app con contenidos distintos). Sin cuenta explícita se usa la
    default (el hub del data lake)."""

    def __init__(self, account: str | None = None) -> None:
        super().__init__()
        from services.catalog_accounts import default_account_id
        self._account = account or default_account_id()

    # ── Llaves (namespace por cuenta) ─────────────────────────────────────────

    def table_entity_pk(self, database: str, table_name: str) -> str:
        """PK de los items funcionales de una tabla (CONTEXT/COLUMN#/USAGE)."""
        return f"TABLE#{self._account}#{database}#{table_name}"

    def catalog_db_pk(self) -> str:
        return f"CATALOG#{self._account}#DB"

    def catalog_tables_pk(self, database: str) -> str:
        return f"CATALOG#{self._account}#{database}"

    # ── Sync meta ─────────────────────────────────────────────────────────────

    def get_catalog_sync_meta(self) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": "CATALOG#SYNC", "SK": f"META#{self._account}"})
        return response.get("Item")

    def put_catalog_sync_meta(self, synced_at: str, status: str) -> None:
        self._table.put_item(Item={
            "PK": "CATALOG#SYNC", "SK": f"META#{self._account}",
            "entityType": "CATALOG_SYNC", "account": self._account,
            "syncedAt": synced_at, "status": status,
        })

    def list_catalog_databases(self) -> list[dict[str, Any]]:
        return self._query_all(KeyConditionExpression=Key("PK").eq(self.catalog_db_pk()))

    def put_catalog_database(self, database: str, table_count: int, synced_at: str, description: str = "", location: str = "", stats: dict[str, Any] | None = None) -> None:
        item: dict[str, Any] = {
            "PK": self.catalog_db_pk(), "SK": database,
            "entityType": "CATALOG_DB", "account": self._account,
            "database": database,
            "tableCount": table_count,
            "syncedAt": synced_at,
            "description": description,
            "location": location,
        }
        if stats is not None:
            item["stats"] = stats
        self._table.put_item(Item=item)

    def update_catalog_table_stats(self, database: str, table: str, stats: dict[str, Any]) -> None:
        """Actualiza solo las stats S3 de una tabla sin reescribir el resto del
        item (preserva el sync diferencial de la metadata de Glue)."""
        self._table.update_item(
            Key={"PK": self.catalog_tables_pk(database), "SK": f"TABLE#{table}"},
            UpdateExpression="SET #st = :st",
            ExpressionAttributeNames={"#st": "stats"},
            ExpressionAttributeValues={":st": stats},
        )

    def list_catalog_tables(self, database: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(self.catalog_tables_pk(database)) & Key("SK").begins_with("TABLE#"),
            ProjectionExpression="#n, #db, tableType, description, columnCount, syncedAt, glueUpdatedAt, #loc, SK",
            ExpressionAttributeNames={"#n": "name", "#db": "database", "#loc": "location"},
        )

    def get_catalog_table(self, database: str, table: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": self.catalog_tables_pk(database), "SK": f"TABLE#{table}"})
        return response.get("Item")

    def put_catalog_table(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)

    def delete_catalog_table(self, database: str, table: str) -> None:
        self._table.delete_item(Key={"PK": self.catalog_tables_pk(database), "SK": f"TABLE#{table}"})

    # ── Contexto funcional ────────────────────────────────────────────────────

    def get_table_context(self, database: str, table_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": self.table_entity_pk(database, table_name), "SK": "CONTEXT"})
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
        prefix = f"TABLE#{self._account}#{database}#"
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

    def get_table_usage(self, database: str, table_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": self.table_entity_pk(database, table_name), "SK": "USAGE"})
        return response.get("Item")

    def put_table_usage_bulk(self, items: list[dict[str, Any]]) -> None:
        with self._table.batch_writer() as batch:
            for item in items:
                batch.put_item(Item=item)

    def list_column_contexts(self, database: str, table_name: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(self.table_entity_pk(database, table_name)) & Key("SK").begins_with("COLUMN#"))

    def get_column_context(self, database: str, table_name: str, column_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": self.table_entity_pk(database, table_name), "SK": f"COLUMN#{column_name}"})
        return response.get("Item")

    def put_context(self, item: dict[str, Any]) -> None:
        """Guarda un item de contexto funcional (TABLE_CONTEXT o COLUMN_CONTEXT)."""
        self._table.put_item(Item=item)
