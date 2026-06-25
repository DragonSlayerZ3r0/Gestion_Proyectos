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
SCAN_HUNG_AFTER = 20 * 60     # un "scanning" más viejo que esto se ignora (colgado)
_MAX_PAGES = 500              # tope de seguridad por área (~500k objetos)
# El nombre de "tabla" sale del filename quitando el sufijo de fecha (YYYYMMDD o
# YYYYMM) y la extensión: MGC_Detalle_Ahorros_20230630.parquet → MGC_Detalle_Ahorros.
_DATE_SUFFIX = re.compile(r"[ _.-]?\d{6,8}$")

# Tabla de control de ingesta (fuente oficial de `record_count` por archivo, cubre
# CSV y PARQUET) consultada vía Athena asumiendo el rol del hub. Athena agrega
# server-side miles de part-files diminutos en segundos (vs. leerlos uno a uno).
RECORDS_ROLE_ARN = "arn:aws:iam::396913696127:role/gestion-proyectos-cost-reader"
RECORDS_REGION = "us-east-1"
ATHENA_WORKGROUP = "primary"
ATHENA_DATABASE = "stage_staging"
ATHENA_TABLE = "ctl_ingestion_unstructured"
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_AREA_RE = re.compile(r"^[\w./ -]+$")  # sanea el área antes de inyectarla en el LIKE
# Fecha LÓGICA del dato (archivo_*), igual que los queries oficiales del reporte
# de ingestas. Distinta de la fecha de partición/ingesta (anio/mes/dia).
_DATA_DATE_SQL = (
    "coalesce(try_cast(concat(cast(archivo_anio as varchar),'-',"
    "lpad(cast(archivo_mes as varchar),2,'0'),'-',"
    "lpad(cast(archivo_dia as varchar),2,'0')) as date), date '1901-01-01')"
)
# Dedup de reprocesos: la ingesta más reciente por target_path (una fila por
# tabla+fecha-lógica). Validado: reconcilia EXACTO con el conteo real de staging.
_LATEST_RN = "row_number() over (partition by target_path order by execution_timestamp desc)"


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
                and (not item or status != "ok" or self._is_stale(scanned_at))):
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
        zone_prefix = self._zone_prefix(bucket, zone)
        now = self._now()
        try:
            data = self._scan_records(bucket, zone_prefix, start, end)
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
        zone_prefix = self._zone_prefix(bucket, zone)
        use_target = self._zone_label(zone_prefix) == "staging"
        path_col = "target_path" if use_target else "s3_key"
        like = (f"s3://arc-enterprise-data/stage/staging/{area}/%" if use_target
                else f"stage/landing/{area}/%")
        # Mismo criterio que el rango: dedup (ingesta más reciente por target_path)
        # y fecha lógica del archivo. Reconcilia con el reporte oficial.
        sql = (
            "SELECT path, recs, bytes FROM ("
            f"SELECT {_DATA_DATE_SQL} AS data_date, {path_col} AS path, "
            f"record_count AS recs, file_size AS bytes, {_LATEST_RN} AS rn "
            f"FROM {ATHENA_TABLE} WHERE bucket_name = 'arc-enterprise-data' "
            f"AND {path_col} LIKE '{like}') "
            f"WHERE rn = 1 AND data_date = date '{day}'"
        )
        athena = self._athena_session().client("athena")
        agg: dict[str, dict[str, int]] = {}
        for path, recs_s, bytes_s in self._athena_query(athena, sql):
            _area, table = self._area_table_from_path(zone_prefix, path)
            if not table:
                continue
            t = agg.setdefault(table, {"rows": 0, "files": 0, "bytes": 0})
            t["rows"] += int(recs_s or 0)
            t["files"] += 1
            t["bytes"] += int(bytes_s or 0)
        return [{"name": k, **v} for k, v in agg.items()]

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

    def _zone_prefix(self, bucket: str, zone: str) -> str:
        for z in INGEST_TARGETS.get(bucket, []):
            if self._zone_label(z) == zone:
                return z
        raise ValidationError("Zona no monitoreada.")

    def _table_of(self, zone_prefix: str, key: str) -> tuple[str | None, str | None]:
        """(área, tabla) a partir de la key. área = 1er nivel bajo la zona.

        - Staging (Hive-particionado: .../tabla/anio=2026/mes=06/.../run-xxx): la
          tabla es la ruta ANTES de la primera partición `clave=valor`.
        - Landing (archivos con fecha en el nombre: MGC_Detalle_Ahorros_20230630.parquet):
          la tabla es la sub-ruta + filename sin la fecha ni la extensión."""
        rel = key[len(zone_prefix):].strip("/")
        parts = rel.split("/")
        if len(parts) < 2:
            return None, None
        area, rest = parts[0], parts[1:]
        cut = next((i for i, p in enumerate(rest) if "=" in p), None)
        if cut is not None:  # hay particiones Hive
            table_parts = rest[:cut]
            return area, ("/".join(table_parts) if table_parts else area)
        sub, filename = rest[:-1], rest[-1]
        stem = _DATE_SUFFIX.sub("", filename.rsplit(".", 1)[0])
        table = "/".join([*sub, stem]) if stem else "/".join(sub) or filename
        return area, table

    def _area_table_from_path(self, zone_prefix: str, path: str) -> tuple[str | None, str | None]:
        """área/tabla desde una ruta del control table. Acepta `s3://bucket/key` o
        key relativo; normaliza y reutiliza _table_of contra el prefijo de la zona."""
        key = path or ""
        if key.startswith("s3://"):
            key = key.split("/", 3)[3] if key.count("/") >= 3 else ""
        return self._table_of(zone_prefix, key)

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

    def _scan_records(self, bucket: str, zone_prefix: str, start: str, end: str) -> dict[str, Any]:
        """Suma record_count/file_size/archivos por área → tabla y área → día desde la
        TABLA DE CONTROL de ingesta vía Athena (agregación server-side, segundos). Para
        staging usa target_path; para landing, s3_key. Filtra al bucket monitoreado."""
        if not (_DATE_RE.match(start) and _DATE_RE.match(end)):
            raise ValidationError("Rango de fechas inválido.")
        use_target = self._zone_label(zone_prefix) == "staging"
        path_col = "target_path" if use_target else "s3_key"
        like = "s3://arc-enterprise-data/stage/staging/%" if use_target else "stage/landing/%"
        # Una fila por target_path = la ingesta más reciente (dedup de reprocesos);
        # día = fecha lógica del archivo. Reconcilia exacto con el reporte oficial.
        sql = (
            "SELECT cast(data_date as varchar) AS day, path, recs, bytes FROM ("
            f"SELECT {_DATA_DATE_SQL} AS data_date, {path_col} AS path, "
            f"record_count AS recs, file_size AS bytes, {_LATEST_RN} AS rn "
            f"FROM {ATHENA_TABLE} WHERE bucket_name = 'arc-enterprise-data' "
            f"AND {path_col} LIKE '{like}') "
            f"WHERE rn = 1 AND data_date BETWEEN date '{start}' AND date '{end}'"
        )
        athena = self._athena_session().client("athena")
        by_area: dict[str, Any] = {}
        file_count = 0
        for day, path, recs_s, bytes_s in self._athena_query(athena, sql):
            area, table = self._area_table_from_path(zone_prefix, path)
            if not area:
                continue
            recs = int(recs_s or 0)
            size = int(bytes_s or 0)
            file_count += 1
            a = by_area.setdefault(area, {"tables": {}, "byDay": {}, "files": 0, "bytes": 0, "rows": 0})
            t = a["tables"].setdefault(table, {"files": 0, "bytes": 0, "rows": 0})
            t["files"] += 1; t["bytes"] += size; t["rows"] += recs
            d = a["byDay"].setdefault(day, {"files": 0, "bytes": 0, "rows": 0})
            d["files"] += 1; d["bytes"] += size; d["rows"] += recs
            a["files"] += 1; a["bytes"] += size; a["rows"] += recs
        return {"byArea": by_area, "start": start, "end": end, "fileCount": file_count}

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
