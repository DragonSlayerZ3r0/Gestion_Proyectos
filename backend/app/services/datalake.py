import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import boto3

from core.errors import ValidationError
from repositories.datalake import DatalakeRepository

# ── Qué se monitorea (Fase 1: listado S3 directo) ─────────────────────────────
# Colector intercambiable: hoy se llena listando S3; en Fase 2 (escala mayor) se
# puede reemplazar por S3 Inventory + lectura del manifiesto, SIN tocar UI/modelo.
# Para agregar buckets/zonas, agrega una entrada aquí. La etiqueta de zona es el
# último segmento del prefijo (landing, staging).
INGEST_TARGETS: dict[str, list[str]] = {
    "arc-enterprise-data": ["stage/landing/", "stage/staging/"],
}

SCAN_TTL = 12 * 3600          # frescura del histograma: 12 h (auto-refresh)
SCAN_HUNG_AFTER = 20 * 60     # un "scanning" más viejo que esto se ignora (colgado)
_MAX_PAGES = 500              # tope de seguridad por área (~500k objetos)


class DatalakeService:
    def __init__(self, repository: DatalakeRepository | None = None) -> None:
        self._db = repository or DatalakeRepository()
        self._s3 = boto3.client("s3")

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _zone_label(self, prefix: str) -> str:
        return prefix.strip("/").split("/")[-1]

    def list_buckets(self) -> list[dict[str, Any]]:
        return [
            {"bucket": b, "zones": [self._zone_label(z) for z in zones]}
            for b, zones in INGEST_TARGETS.items()
        ]

    def _validate_bucket(self, bucket: str) -> None:
        if bucket not in INGEST_TARGETS:
            raise ValidationError("Bucket no monitoreado.")

    # ── Lectura (UI) ─────────────────────────────────────────────────────────
    def get_overview(self, bucket: str, function_name: str | None = None,
                     auto: bool = True) -> dict[str, Any]:
        self._validate_bucket(bucket)
        item = self._db.get_overview(bucket)
        status = (item.get("status") if item else None) or "empty"
        scanned_at = item.get("scannedAt") if item else None
        scanning = status == "scanning" and not self._is_hung(item)

        # Auto-refresh: si está vencido (o nunca se calculó) y no hay scan vivo,
        # dispara uno en segundo plano y devuelve lo que haya (frontend hace poll).
        if auto and function_name and not scanning and (not item or self._is_stale(scanned_at)):
            self.start_scan(bucket, function_name)
            scanning = True

        return {
            "bucket": bucket,
            "data": item.get("data") if item else None,
            "scannedAt": scanned_at,
            "scanning": scanning,
            "status": status,
            "ttlHours": SCAN_TTL // 3600,
        }

    def get_zone_detail(self, bucket: str, zone: str) -> dict[str, Any]:
        self._validate_bucket(bucket)
        item = self._db.get_zone_detail(bucket, zone)
        return {"bucket": bucket, "zone": zone, "byArea": (item.get("data") if item else {}) or {}}

    # ── Disparo del escaneo (async self-invoke) ──────────────────────────────
    def start_scan(self, bucket: str, function_name: str) -> dict[str, Any]:
        self._validate_bucket(bucket)
        self._db.set_status(bucket, "scanning", self._now())
        boto3.client("lambda").invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps({"action": "datalake_ingest_scan", "bucket": bucket}).encode(),
        )
        return {"bucket": bucket, "scanning": True}

    # ── Trabajo pesado (ejecutado async por self-invocation) ─────────────────
    def run_scan(self, bucket: str) -> None:
        self._validate_bucket(bucket)
        now = self._now()
        try:
            overview, details = self._scan(bucket)
            for zone, by_area in details.items():
                self._db.put_zone_detail(bucket, zone, by_area)
            self._db.put_overview(bucket, overview, now, "ok")
        except Exception:
            self._db.set_status(bucket, "error", now)
            raise

    def _scan(self, bucket: str) -> tuple[dict[str, Any], dict[str, Any]]:
        overview_zones: dict[str, Any] = {}
        details: dict[str, Any] = {}
        for zone_prefix in INGEST_TARGETS[bucket]:
            zone = self._zone_label(zone_prefix)
            areas = self._list_areas(bucket, zone_prefix)

            def _one(target: tuple[str, str]) -> tuple[str, dict[str, Any]]:
                area, prefix = target
                return area, self._scan_prefix(bucket, prefix)

            by_area: dict[str, Any] = {}
            if areas:
                with ThreadPoolExecutor(max_workers=12) as pool:
                    for area, hist in pool.map(_one, areas):
                        by_area[area] = hist

            zone_by_day: dict[str, dict[str, int]] = {}
            area_totals: list[dict[str, Any]] = []
            z_count = 0
            z_bytes = 0
            for area, hist in by_area.items():
                z_count += hist["count"]
                z_bytes += hist["bytes"]
                area_totals.append({"area": area, "count": hist["count"], "bytes": hist["bytes"]})
                for day, v in hist["byDay"].items():
                    agg = zone_by_day.setdefault(day, {"count": 0, "bytes": 0})
                    agg["count"] += v["count"]
                    agg["bytes"] += v["bytes"]
            area_totals.sort(key=lambda a: a["bytes"], reverse=True)

            overview_zones[zone] = {
                "byDay": zone_by_day, "areas": area_totals,
                "count": z_count, "bytes": z_bytes,
            }
            details[zone] = {area: hist["byDay"] for area, hist in by_area.items()}

        return {"zones": overview_zones}, details

    def _list_areas(self, bucket: str, zone_prefix: str) -> list[tuple[str, str]]:
        """Las 'áreas' son los prefijos de primer nivel dentro de la zona."""
        areas: list[tuple[str, str]] = []
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=zone_prefix, Delimiter="/"):
            for cp in page.get("CommonPrefixes", []):
                prefix = cp["Prefix"]
                area = prefix[len(zone_prefix):].strip("/")
                if area:
                    areas.append((area, prefix))
        return areas

    def _scan_prefix(self, bucket: str, prefix: str) -> dict[str, Any]:
        """Lista el prefijo y agrupa por fecha de LastModified (UTC)."""
        by_day: dict[str, dict[str, int]] = {}
        count = 0
        total = 0
        paginator = self._s3.get_paginator("list_objects_v2")
        pages = 0
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj.get("Key", "")
                if key.endswith("/"):  # marcadores de "carpeta" (tamaño 0)
                    continue
                size = obj.get("Size", 0) or 0
                lm = obj.get("LastModified")
                day = lm.strftime("%Y-%m-%d") if lm else "desconocida"
                agg = by_day.setdefault(day, {"count": 0, "bytes": 0})
                agg["count"] += 1
                agg["bytes"] += size
                count += 1
                total += size
            pages += 1
            if pages >= _MAX_PAGES:
                break
        return {"byDay": by_day, "count": count, "bytes": total}

    # ── Helpers de frescura/estado ───────────────────────────────────────────
    def _is_stale(self, scanned_at: Any) -> bool:
        age = self._age_seconds(scanned_at)
        return age is None or age > SCAN_TTL

    def _is_hung(self, item: dict[str, Any] | None) -> bool:
        if not item:
            return False
        age = self._age_seconds(item.get("startedAt") or item.get("scannedAt"))
        return age is None or age > SCAN_HUNG_AFTER

    def _age_seconds(self, iso: Any) -> float | None:
        if not iso:
            return None
        try:
            dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None
        return (datetime.now(timezone.utc) - dt).total_seconds()
