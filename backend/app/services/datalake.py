import json
import re
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
RECENT_TTL = 30 * 60          # ventanas que incluyen HOY: el día en curso sigue creciendo
SCAN_HUNG_AFTER = 20 * 60     # un "scanning" más viejo que esto se ignora (colgado)
_MAX_PAGES = 500              # tope de seguridad por área (~500k objetos)

# Tabla de control de ingesta (fuente oficial de `record_count` por archivo, cubre
# CSV y PARQUET) consultada vía Athena asumiendo el rol del hub. Athena agrega
# server-side miles de part-files diminutos en segundos (vs. leerlos uno a uno).
RECORDS_ROLE_ARN = "arn:aws:iam::396913696127:role/gestion-proyectos-cost-reader"
RECORDS_REGION = "us-east-1"
ATHENA_WORKGROUP = "primary"
ATHENA_DATABASE = "stage_staging"
ATHENA_TABLE = "ctl_ingestion_unstructured"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_AREA_RE = re.compile(r"^[\w./ -]+$")  # sanea source_system antes de inyectarlo en el filtro
# Consulta OFICIAL del reporte de ingestas (equipo de datos). Agrupa por:
#  - source_system (con remapeo de los orígenes que cuelgan de "Canales Digitales/"),
#  - file_name normalizado (sin el sufijo _YYYYMMDD…),
#  - ingestion_date (columna = fecha real de ingesta, no la lógica del archivo).
# Deduplica reprocesos con DISTINCT(source_system, file_name, record_count, ingestion_date).
# Es zona-agnóstico (la tabla de control no separa landing/staging).
_SRC_SQL = (
    "if(source_system in ('Tarjeta de credito','Canales alternos','Canales digitales',"
    "'Inteligencia de negocios'), concat('Canales Digitales/', source_system, '/'), source_system)"
)
_FNAME_SQL = "regexp_replace(file_name, '_[0-9]{8}.*$', '')"
_IDATE_SQL = "CAST(date_parse(ingestion_date, '%Y-%m-%d %H:%i:%s') AS DATE)"


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

    # ── Registros (conteo de filas por área/tabla, acotado a un rango) ──────────
    # El conteo de filas NO sale del listado S3: se consulta la TABLA DE CONTROL de
    # ingesta vía Athena (record_count exacto, cubre CSV y PARQUET, agrega miles de
    # part-files en segundos). Acotado al rango elegido y cacheado por
    # (bucket, zona, inicio, fin), igual que el resto del módulo.
    def get_records(self, bucket: str, zone: str, start: str, end: str,
                    function_name: str | None = None, auto: bool = True) -> dict[str, Any]:
        self._validate_bucket(bucket)
        if not start or not end:
            raise ValidationError("Selecciona un rango de fechas para ver registros.")
        item = self._db.get_records(bucket, zone, start, end)
        status = (item.get("status") if item else None) or "empty"
        scanned_at = item.get("scannedAt") if item else None
        scanning = status == "scanning" and not self._is_hung(item)

        if (auto and function_name and not scanning
                and (not item or status != "ok" or self._is_stale(scanned_at, end))):
            self.start_records_scan(bucket, zone, start, end, function_name)
            scanning = True

        return {
            "bucket": bucket, "zone": zone, "start": start, "end": end,
            "data": item.get("data") if item else None,
            "scannedAt": scanned_at, "scanning": scanning, "status": status,
        }

    def start_records_scan(self, bucket: str, zone: str, start: str, end: str,
                           function_name: str) -> dict[str, Any]:
        self._validate_bucket(bucket)
        if not start or not end:
            raise ValidationError("Selecciona un rango de fechas para ver registros.")
        self._db.set_records_status(bucket, zone, start, end, "scanning", self._now())
        boto3.client("lambda").invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps({
                "action": "datalake_records_scan",
                "bucket": bucket, "zone": zone, "start": start, "end": end,
            }).encode(),
        )
        return {"scanning": True}

    def run_records_scan(self, bucket: str, zone: str, start: str, end: str) -> None:
        self._validate_bucket(bucket)
        now = self._now()
        try:
            data = self._scan_records(start, end)  # zona-agnóstico (tabla de control)
            self._db.put_records(bucket, zone, start, end, data, now, "ok")
        except Exception:
            self._db.set_records_status(bucket, zone, start, end, "error", now)
            raise

    # Detalle de TABLAS de un (área, día) bajo demanda (drill de "Por fecha" →
    # área → tablas). No cabe en el caché del rango (miles de combinaciones área×
    # tabla×día > 400KB), así que se consulta puntual a Athena y se cachea por
    # (bucket, zona, área, día) en items pequeños. Síncrono (consulta diminuta).
    def get_day_tables(self, bucket: str, zone: str, area: str, day: str) -> dict[str, Any]:
        self._validate_bucket(bucket)
        if not _DATE_RE.match(day or ""):
            raise ValidationError("Fecha inválida.")
        if not _AREA_RE.match(area or ""):
            raise ValidationError("Área inválida.")
        item = self._db.get_day_tables(bucket, zone, area, day)
        if item and item.get("data") is not None and not self._is_stale(item.get("scannedAt")):
            return {"zone": zone, "area": area, "day": day, "tables": item["data"], "cached": True}
        tables = self._scan_day_tables(bucket, zone, area, day)
        self._db.put_day_tables(bucket, zone, area, day, tables, self._now())
        return {"zone": zone, "area": area, "day": day, "tables": tables, "cached": False}

    def _scan_day_tables(self, bucket: str, zone: str, area: str, day: str) -> list[dict[str, Any]]:
        """file_names ingestados por un source_system (`area`) en un `ingestion_date`
        concreto. Misma consulta oficial; `area` ya viene saneado por _AREA_RE."""
        sql = (
            "SELECT file_name, status, count(*) AS quantity, sum(record_count) AS records FROM ("
            f"SELECT DISTINCT {_SRC_SQL} AS source_system, {_FNAME_SQL} AS file_name, "
            f"record_count, {_IDATE_SQL} AS ingestion_date, status FROM {ATHENA_TABLE}) "
            f"WHERE ingestion_date = date '{day}' AND source_system = '{area}' "
            "GROUP BY file_name, status"
        )
        athena = self._athena_session().client("athena")
        out: list[dict[str, Any]] = []
        for table, status, qty_s, rec_s in self._athena_query(athena, sql):
            out.append({"name": table or "(sin nombre)", "status": status or "",
                        "files": int(qty_s or 0), "rows": int(rec_s or 0)})
        return out

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

    def _athena_session(self):
        """Sesión boto3 con el rol del hub (Athena/Glue/S3 del catálogo de control)."""
        creds = boto3.client("sts").assume_role(
            RoleArn=RECORDS_ROLE_ARN, RoleSessionName="gp-datalake-records",
        )["Credentials"]
        return boto3.Session(
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
            region_name=RECORDS_REGION,
        )

    def _athena_query(self, athena, sql: str) -> list[list[str]]:
        """Ejecuta una consulta Athena y devuelve las filas (sin el encabezado)."""
        import time
        qid = athena.start_query_execution(
            QueryString=sql,
            WorkGroup=ATHENA_WORKGROUP,
            QueryExecutionContext={"Database": ATHENA_DATABASE},
        )["QueryExecutionId"]
        info: dict[str, Any] = {}
        state = "QUEUED"
        for _ in range(90):  # ~180s máx (corre en la invocación async)
            info = athena.get_query_execution(QueryExecutionId=qid)["QueryExecution"]["Status"]
            state = info["State"]
            if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
                break
            time.sleep(2)
        if state != "SUCCEEDED":
            raise ValueError(f"Consulta de registros falló: {info.get('StateChangeReason') or state}")
        rows: list[list[str]] = []
        paginator = athena.get_paginator("get_query_results")
        first = True
        for page in paginator.paginate(QueryExecutionId=qid):
            for r in page["ResultSet"]["Rows"]:
                if first:  # encabezado
                    first = False
                    continue
                rows.append([c.get("VarCharValue") for c in r["Data"]])
        return rows

    def _scan_records(self, start: str, end: str) -> dict[str, Any]:
        """Ingestas por **source_system → file_name** y por **ingestion_date**, vía Athena
        con la consulta OFICIAL del reporte (DISTINCT dedup, source_system remapeado,
        file_name sin fecha). Zona-agnóstico. `quantity`=count(*)=ingestas, `record_count`
        =filas. (No incluye peso: la consulta oficial no lo reporta.)"""
        if not (_DATE_RE.match(start) and _DATE_RE.match(end)):
            raise ValidationError("Rango de fechas inválido.")
        sql = (
            "SELECT cast(ingestion_date as varchar) AS day, source_system, file_name, status, "
            "count(*) AS quantity, sum(record_count) AS records FROM ("
            f"SELECT DISTINCT {_SRC_SQL} AS source_system, {_FNAME_SQL} AS file_name, "
            f"record_count, {_IDATE_SQL} AS ingestion_date, status FROM {ATHENA_TABLE}) "
            f"WHERE ingestion_date BETWEEN date '{start}' AND date '{end}' "
            "GROUP BY ingestion_date, source_system, file_name, status"
        )
        athena = self._athena_session().client("athena")
        by_area: dict[str, Any] = {}
        for day, area, table, status, qty_s, rec_s in self._athena_query(athena, sql):
            if not area:
                continue
            qty = int(qty_s or 0)
            rec = int(rec_s or 0)
            name = table or "(sin nombre)"
            status = status or ""
            a = by_area.setdefault(area, {"tables": {}, "byDay": {}, "files": 0, "rows": 0})
            t = a["tables"].setdefault(f"{name} {status}", {"name": name, "status": status, "files": 0, "rows": 0})
            t["files"] += qty; t["rows"] += rec
            d = a["byDay"].setdefault(day, {"files": 0, "rows": 0})
            d["files"] += qty; d["rows"] += rec
            a["files"] += qty; a["rows"] += rec
        return {"byArea": by_area, "start": start, "end": end}

    # ── Helpers de frescura/estado ───────────────────────────────────────────
    def _is_stale(self, scanned_at: Any, end: str | None = None) -> bool:
        age = self._age_seconds(scanned_at)
        if age is None:
            return True
        # Si la ventana incluye HOY, el día en curso sigue creciendo → TTL corto para
        # que todos los rangos converjan; los rangos ya cerrados (fin < hoy) son
        # inmutables y conservan el TTL largo. Sin `end` (overview) = comportamiento previo.
        ttl = RECENT_TTL if self._includes_today(end) else SCAN_TTL
        return age > ttl

    def _includes_today(self, end: str | None) -> bool:
        if not end:
            return False
        return end >= datetime.now(timezone.utc).strftime("%Y-%m-%d")

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
