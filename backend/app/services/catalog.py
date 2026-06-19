import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import boto3

from repositories.dynamodb import MainTableRepository
from repositories.glue import GlueRepository


class CatalogService:
    def __init__(self) -> None:
        self._glue = GlueRepository()
        self._db = MainTableRepository()
        self._s3 = boto3.client("s3")

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

    def get_table(self, database: str, table_name: str, include_stats: bool = False) -> dict[str, Any]:
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
        result = {
            "name": item["name"],
            "database": database,
            "tableType": item.get("tableType", ""),
            "description": item.get("description", ""),
            "location": item.get("location", ""),
            # Ficha técnica (metadata de Glue cacheada en el sync)
            "format": item.get("format", ""),
            "partitionKeys": item.get("partitionKeys", []),
            "glueCreatedAt": item.get("glueCreatedAt"),
            "glueUpdatedAt": item.get("glueUpdatedAt"),
            "syncedAt": item.get("syncedAt"),
            "context": _format_table_context(table_context),
            "columns": columns,
        }
        # Las stats S3 (tamaño/archivos/frescura) se calculan durante el sync y se
        # guardan en el item. Aquí solo se leen del caché — la consulta es instantánea.
        if include_stats:
            result["stats"] = item.get("stats") or {"available": False, "reason": "Aún no calculado. Sincroniza la tabla."}
        return result

    def get_database_info(self, database: str, include_stats: bool = False) -> dict[str, Any]:
        """Metadata de la BD desde la caché DynamoDB. Las stats S3 agregadas
        (tamaño total/archivos/frescura) se calculan durante el sync y se leen
        del caché — la consulta es instantánea."""
        databases = self._db.list_catalog_databases()
        db_item = next((d for d in databases if d.get("database") == database or d.get("SK") == database), None)
        if not db_item:
            raise ValueError(f"Base de datos {database} no encontrada en el caché.")
        result = _format_db_cache(db_item)
        if include_stats:
            result["stats"] = db_item.get("stats") or {"available": False, "reason": "Aún no calculado. Sincroniza la base de datos."}
        return result

    def get_table_stats(self, database: str, table_name: str) -> dict[str, Any]:
        item = self._db.get_catalog_table(database, table_name)
        if not item:
            raise ValueError(f"Tabla {table_name} no encontrada en el caché.")
        return item.get("stats") or self._s3_stats(item.get("location", ""))

    def _s3_stats(self, location: str) -> dict[str, Any]:
        """Tamaño total, nº de archivos y última modificación (frescura) listando
        el prefijo S3 de la tabla. Solo lectura. Degrada con gracia si la tabla
        está en un bucket sin permiso o sin ubicación."""
        if not location.startswith("s3://"):
            return {"available": False, "reason": "Sin ubicación S3."}
        bucket, _, prefix = location[5:].partition("/")
        total_bytes = 0
        object_count = 0
        latest = None
        truncated = False
        try:
            paginator = self._s3.get_paginator("list_objects_v2")
            page_iter = paginator.paginate(Bucket=bucket, Prefix=prefix)
            pages = 0
            for page in page_iter:
                for obj in page.get("Contents", []):
                    total_bytes += obj.get("Size", 0)
                    object_count += 1
                    last_modified = obj.get("LastModified")
                    if last_modified and (latest is None or last_modified > latest):
                        latest = last_modified
                pages += 1
                if pages >= 200:  # tope de seguridad (~200k objetos)
                    truncated = True
                    break
        except Exception:
            return {"available": False, "reason": "Sin acceso al bucket o ruta inexistente."}
        return {
            "available": True,
            "sizeBytes": total_bytes,
            "objectCount": object_count,
            "lastModified": latest.isoformat() if latest else None,
            "truncated": truncated,
        }

    def _compute_database_stats(self, raw_tables: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
        """Calcula las stats S3 de todas las tablas de una BD con un listado
        DIRIGIDO por tabla (solo su prefijo, lee únicamente sus objetos) ejecutado
        en paralelo con hilos. Devuelve (stats_por_tabla, agregado_de_la_bd).

        Frente a "una listada por bucket": es exacto (no lee objetos ajenos ni se
        trunca al tope del bucket cuando las tablas están dispersas) y rápido
        gracias a la concurrencia. El cliente boto3 es thread-safe para llamadas."""
        targets = [
            (raw["Name"], (raw.get("StorageDescriptor", {}) or {}).get("Location", "") or "")
            for raw in raw_tables
        ]
        if not targets:
            return {}, {"available": False, "reason": "La base de datos no tiene tablas."}

        def _one(item: tuple[str, str]) -> tuple[str, dict[str, Any]]:
            name, location = item
            return name, self._s3_stats(location)

        table_stats: dict[str, dict[str, Any]] = {}
        with ThreadPoolExecutor(max_workers=12) as pool:
            for name, st in pool.map(_one, targets):
                table_stats[name] = st

        # Agregado de la BD: suma de las tablas con stats disponibles.
        has_location = any(loc.startswith("s3://") for _, loc in targets)
        agg_bytes = 0
        agg_count = 0
        agg_latest = None  # ISO string; comparación lexicográfica válida (todo UTC)
        agg_truncated = False
        any_available = False
        for st in table_stats.values():
            if not st.get("available"):
                continue
            any_available = True
            agg_bytes += st.get("sizeBytes", 0)
            agg_count += st.get("objectCount", 0)
            agg_truncated = agg_truncated or st.get("truncated", False)
            lm = st.get("lastModified")
            if lm and (agg_latest is None or lm > agg_latest):
                agg_latest = lm

        if not has_location:
            db_stats: dict[str, Any] = {"available": False, "reason": "Ninguna tabla tiene ubicación S3."}
        elif not any_available:
            db_stats = {"available": False, "reason": "Sin acceso a los buckets."}
        else:
            db_stats = {
                "available": True,
                "sizeBytes": agg_bytes,
                "objectCount": agg_count,
                "lastModified": agg_latest,
                "truncated": agg_truncated,
            }
        return table_stats, db_stats

    # ── Sync individual de tabla (síncrono, <1s) ─────────────────────────────

    def sync_table(self, database: str, table_name: str) -> dict[str, Any]:
        raw = self._glue.get_table(database, table_name)
        if not raw:
            raise ValueError(f"Tabla {table_name} no encontrada en Glue.")
        now = datetime.now(timezone.utc).isoformat()
        item = _build_table_cache_item(database, raw, now)
        # Stats S3 de la tabla, guardadas en el item para lectura instantánea
        try:
            item["stats"] = self._s3_stats(item.get("location", ""))
        except Exception:
            pass
        self._db.put_catalog_table(item)
        # Actualizar conteo en el meta de la BD
        existing_tables = self._db.list_catalog_tables(database)
        self._db.put_catalog_database(database, len(existing_tables), now)
        return _format_table_cache(item)

    # ── Sync de una base de datos completa (síncrono) ─────────────────────────

    def sync_database(self, database: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        glue_db = self._glue.get_database(database) or {}
        result = self._sync_database_tables(
            database, now,
            description=glue_db.get("Description", ""),
            location=glue_db.get("LocationUri", ""),
        )
        return {
            "database": database,
            "tableCount": result["tableCount"],
            "updated": result["updated"],
            "removed": result["removed"],
            "syncedAt": now,
        }

    def _sync_database_tables(self, database: str, now: str, description: str = "", location: str = "") -> dict[str, Any]:
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
        # Stats S3 (tamaño/archivos/frescura): una listada por bucket, atribuida a
        # cada tabla. Se guardan en cada item (sin reescribir su metadata Glue) y el
        # agregado en el item de la BD. Falla suave para no romper el sync.
        db_stats = None
        try:
            table_stats, db_stats = self._compute_database_stats(raw_tables)
            for table_name, st in table_stats.items():
                self._db.update_catalog_table_stats(database, table_name, st)
        except Exception:
            db_stats = None
        self._db.put_catalog_database(database, len(raw_tables), now, description, location, db_stats)
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
                self._sync_database_tables(db_name, now, description, db.get("LocationUri", ""))
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
            "usagePrimary": body.get("usagePrimary", ""),
            "domain": body.get("domain", ""),
            "responsible": body.get("responsible", ""),
            "sensitivity": body.get("sensitivity", ""),
            "status": body.get("status", ""),
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
            "sensitivity": body.get("sensitivity", ""),
            "sampleValue": body.get("sampleValue", ""),
            "notes": body.get("notes", ""),
            "updatedAt": now, "updatedBy": identity["userId"],
            "createdAt": existing.get("createdAt", now) if existing else now,
            "createdBy": existing.get("createdBy", identity["userId"]) if existing else identity["userId"],
        }
        self._db.put_item(item)
        return _format_column_context(item)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _glue_iso(value: Any) -> str:
    """Convierte un datetime/valor de Glue a ISO string (o vacío)."""
    if value is None:
        return ""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _glue_updated_at(raw: dict[str, Any]) -> str:
    """UpdateTime de Glue como ISO string (usado por el sync diferencial)."""
    return _glue_iso(raw.get("UpdateTime"))


def _derive_format(raw: dict[str, Any], storage: dict[str, Any]) -> str:
    """Formato físico legible: usa Parameters.classification y, si falta, lo
    deduce de la librería SerDe. Vacío si no se puede determinar."""
    classification = (raw.get("Parameters") or {}).get("classification", "")
    if classification:
        return classification.lower()
    serde = ((storage.get("SerdeInfo") or {}).get("SerializationLibrary") or "").lower()
    if "parquet" in serde:
        return "parquet"
    if "orc" in serde:
        return "orc"
    if "json" in serde:
        return "json"
    if "csv" in serde or "opencsv" in serde or "lazysimple" in serde:
        return "csv"
    if "avro" in serde:
        return "avro"
    return ""


def _build_table_cache_item(database: str, raw: dict[str, Any], synced_at: str) -> dict[str, Any]:
    storage = raw.get("StorageDescriptor", {})
    partition_keys = raw.get("PartitionKeys") or []
    columns = [
        {"name": c["Name"], "type": c.get("Type", ""), "comment": c.get("Comment", ""), "isPartition": False}
        for c in storage.get("Columns", [])
    ] + [
        {"name": c["Name"], "type": c.get("Type", ""), "comment": c.get("Comment", ""), "isPartition": True}
        for c in partition_keys
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
        # Ficha técnica derivada de Glue (solo lectura)
        "format": _derive_format(raw, storage),
        "partitionKeys": [c["Name"] for c in partition_keys],
        "glueCreatedAt": _glue_iso(raw.get("CreateTime")),
        "syncedAt": synced_at,
        "glueUpdatedAt": _glue_updated_at(raw),
    }


def _format_db_cache(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": item.get("database", item.get("SK", "")),
        "description": item.get("description", ""),
        "tableCount": item.get("tableCount", 0),
        "syncedAt": item.get("syncedAt"),
        "location": item.get("location", ""),
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
        return {"description": "", "usagePrimary": "", "domain": "", "responsible": "", "sensitivity": "", "status": "", "usageNotes": ""}
    return {
        "description": ctx.get("description", ""),
        "usagePrimary": ctx.get("usagePrimary", ""),
        "domain": ctx.get("domain", ""),
        "responsible": ctx.get("responsible", ""),
        "sensitivity": ctx.get("sensitivity", ""),
        "status": ctx.get("status", ""),
        "usageNotes": ctx.get("usageNotes", ""),
    }


def _format_column_context(ctx: dict[str, Any] | None) -> dict[str, Any]:
    if not ctx:
        return {"description": "", "sensitivity": "", "sampleValue": "", "notes": ""}
    return {
        "description": ctx.get("description", ""),
        "sensitivity": ctx.get("sensitivity", ""),
        "sampleValue": ctx.get("sampleValue", ""),
        "notes": ctx.get("notes", ""),
    }
