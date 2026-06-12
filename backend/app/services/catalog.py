import json
import os
from datetime import datetime, timezone
from typing import Any

import boto3

from repositories.dynamodb import MainTableRepository
from repositories.glue import GlueRepository


class CatalogService:
    def __init__(self) -> None:
        self._glue = GlueRepository()
        self._db = MainTableRepository()

    # ── Lectura desde caché DynamoDB (siempre rápida) ────────────────────────

    def list_databases(self) -> dict[str, Any]:
        sync_meta = self._db.get_catalog_sync_meta()
        databases = self._db.list_catalog_databases()
        return {
            "databases": sorted([_format_db_cache(d) for d in databases], key=lambda d: d["name"]),
            "syncedAt": sync_meta.get("syncedAt") if sync_meta else None,
            "syncStatus": sync_meta.get("status") if sync_meta else None,
        }

    def list_tables(self, database: str) -> list[dict[str, Any]]:
        items = self._db.list_catalog_tables(database)
        return sorted([_format_table_cache(t) for t in items], key=lambda t: t["name"])

    def get_table(self, database: str, table_name: str) -> dict[str, Any]:
        item = self._db.get_catalog_table(database, table_name)
        if not item:
            raise ValueError(f"Tabla {table_name} no encontrada en el caché. Sincroniza la base de datos primero.")
        table_context = self._db.get_table_context(database, table_name)
        column_contexts = self._db.list_column_contexts(database, table_name)
        context_by_column = {c.get("columnName"): c for c in column_contexts}
        columns = [
            {**col, "context": _format_column_context(context_by_column.get(col["name"]))}
            for col in (item.get("columns") or [])
        ]
        return {
            "name": item["name"],
            "database": database,
            "tableType": item.get("tableType", ""),
            "description": item.get("description", ""),
            "location": item.get("location", ""),
            "syncedAt": item.get("syncedAt"),
            "context": _format_table_context(table_context),
            "columns": columns,
        }

    # ── Sync individual de tabla (síncrono, <1s) ─────────────────────────────

    def sync_table(self, database: str, table_name: str) -> dict[str, Any]:
        raw = self._glue.get_table(database, table_name)
        if not raw:
            raise ValueError(f"Tabla {table_name} no encontrada en Glue.")
        now = datetime.now(timezone.utc).isoformat()
        item = _build_table_cache_item(database, raw, now)
        self._db.put_catalog_table(item)
        # Actualizar conteo en el meta de la BD
        existing_tables = self._db.list_catalog_tables(database)
        self._db.put_catalog_database(database, len(existing_tables), now)
        return _format_table_cache(item)

    # ── Sync de una base de datos completa (síncrono) ─────────────────────────

    def sync_database(self, database: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        result = self._sync_database_tables(database, now)
        return {
            "database": database,
            "tableCount": result["tableCount"],
            "updated": result["updated"],
            "removed": result["removed"],
            "syncedAt": now,
        }

    def _sync_database_tables(self, database: str, now: str, description: str = "") -> dict[str, Any]:
        """Sync diferencial: escribe solo tablas nuevas o con cambios en Glue
        (comparando UpdateTime) y elimina del caché las que ya no existen
        (huérfanas). Diseñado para data lakes grandes en crecimiento."""
        raw_tables = self._glue.list_tables(database)
        cached_by_name = {
            (c.get("name") or c.get("SK", "").removeprefix("TABLE#")): c
            for c in self._db.list_catalog_tables(database)
        }
        updated = 0
        for raw in raw_tables:
            cached = cached_by_name.pop(raw["Name"], None)
            glue_updated_at = _glue_updated_at(raw)
            if cached and glue_updated_at and cached.get("glueUpdatedAt") == glue_updated_at:
                continue  # sin cambios en Glue: no se reescribe
            self._db.put_catalog_table(_build_table_cache_item(database, raw, now))
            updated += 1
        # Lo que quedó en cached_by_name ya no existe en Glue: huérfanas
        for orphan_name in cached_by_name:
            if orphan_name:
                self._db.delete_catalog_table(database, orphan_name)
        self._db.put_catalog_database(database, len(raw_tables), now, description)
        return {"tableCount": len(raw_tables), "updated": updated, "removed": len(cached_by_name)}

    # ── Sync global (invoca Lambda de forma asíncrona) ────────────────────────

    def start_sync_all(self, function_name: str) -> str:
        now = datetime.now(timezone.utc).isoformat()
        self._db.put_catalog_sync_meta(now, "syncing")
        boto3.client("lambda").invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps({"action": "catalog_sync_all"}).encode(),
        )
        return now

    def run_sync_all(self) -> None:
        """Ejecutado de forma asíncrona por Lambda self-invocation o EventBridge."""
        now = datetime.now(timezone.utc).isoformat()
        self._db.put_catalog_sync_meta(now, "syncing")
        databases = self._glue.list_databases()
        for db in databases:
            db_name = db["Name"]
            description = db.get("Description", "")
            try:
                self._sync_database_tables(db_name, now, description)
            except Exception:
                pass
        self._db.put_catalog_sync_meta(now, "ok")

    # ── Contexto funcional (escrito por usuarios) ─────────────────────────────

    def save_table_context(self, database: str, table_name: str, body: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        existing = self._db.get_table_context(database, table_name)
        item: dict[str, Any] = {
            "PK": f"TABLE#{database}#{table_name}", "SK": "CONTEXT",
            "entityType": "TABLE_CONTEXT",
            "database": database, "tableName": table_name,
            "description": body.get("description", ""),
            "responsible": body.get("responsible", ""),
            "sensitivity": body.get("sensitivity", ""),
            "usageNotes": body.get("usageNotes", ""),
            "updatedAt": now, "updatedBy": identity["userId"],
            "createdAt": existing.get("createdAt", now) if existing else now,
            "createdBy": existing.get("createdBy", identity["userId"]) if existing else identity["userId"],
        }
        self._db.put_item(item)
        return _format_table_context(item)

    def save_column_context(self, database: str, table_name: str, column_name: str, body: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        existing = self._db.get_column_context(database, table_name, column_name)
        item: dict[str, Any] = {
            "PK": f"TABLE#{database}#{table_name}", "SK": f"COLUMN#{column_name}",
            "entityType": "COLUMN_CONTEXT",
            "database": database, "tableName": table_name, "columnName": column_name,
            "description": body.get("description", ""),
            "notes": body.get("notes", ""),
            "updatedAt": now, "updatedBy": identity["userId"],
            "createdAt": existing.get("createdAt", now) if existing else now,
            "createdBy": existing.get("createdBy", identity["userId"]) if existing else identity["userId"],
        }
        self._db.put_item(item)
        return _format_column_context(item)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _glue_updated_at(raw: dict[str, Any]) -> str:
    """UpdateTime de Glue como ISO string (Glue lo entrega como datetime)."""
    value = raw.get("UpdateTime")
    if value is None:
        return ""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _build_table_cache_item(database: str, raw: dict[str, Any], synced_at: str) -> dict[str, Any]:
    storage = raw.get("StorageDescriptor", {})
    columns = [
        {"name": c["Name"], "type": c.get("Type", ""), "comment": c.get("Comment", ""), "isPartition": False}
        for c in storage.get("Columns", [])
    ] + [
        {"name": c["Name"], "type": c.get("Type", ""), "comment": c.get("Comment", ""), "isPartition": True}
        for c in raw.get("PartitionKeys", [])
    ]
    return {
        "PK": f"CATALOG#{database}",
        "SK": f"TABLE#{raw['Name']}",
        "entityType": "CATALOG_TABLE",
        "name": raw["Name"],
        "database": database,
        "tableType": raw.get("TableType", ""),
        "description": raw.get("Description", ""),
        "location": storage.get("Location", ""),
        "columnCount": len(columns),
        "columns": columns,
        "syncedAt": synced_at,
        "glueUpdatedAt": _glue_updated_at(raw),
    }


def _format_db_cache(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": item.get("database", item.get("SK", "")),
        "description": item.get("description", ""),
        "tableCount": item.get("tableCount", 0),
        "syncedAt": item.get("syncedAt"),
    }


def _format_table_cache(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": item.get("name", ""),
        "database": item.get("database", ""),
        "tableType": item.get("tableType", ""),
        "description": item.get("description", ""),
        "columnCount": item.get("columnCount", 0),
        "syncedAt": item.get("syncedAt"),
    }


def _format_table_context(ctx: dict[str, Any] | None) -> dict[str, Any]:
    if not ctx:
        return {"description": "", "responsible": "", "sensitivity": "", "usageNotes": ""}
    return {
        "description": ctx.get("description", ""),
        "responsible": ctx.get("responsible", ""),
        "sensitivity": ctx.get("sensitivity", ""),
        "usageNotes": ctx.get("usageNotes", ""),
    }


def _format_column_context(ctx: dict[str, Any] | None) -> dict[str, Any]:
    if not ctx:
        return {"description": "", "notes": ""}
    return {"description": ctx.get("description", ""), "notes": ctx.get("notes", "")}
