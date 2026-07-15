import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3

from core.errors import ValidationError
from repositories.athena_monitor import AthenaMonitorRepository
from repositories.catalog import CatalogRepository
from services.name_directory import NameDirectory
from services.sql_context import SqlCatalogContext
from services.sql_lint import ANTIPATTERNS as _ANTIPATTERNS, lint_sql as _lint_sql
from services.llm import LlmService

# sqlglot vendorizado (puro-Python, sin capa Lambda) para analizar el SQL por AST.
_VENDOR = os.path.join(os.path.dirname(__file__), "..", "_vendor")
if _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)
try:
    import sqlglot
    from sqlglot import exp as _exp
except Exception:        # pragma: no cover - si faltara el vendor, el lint queda inerte
    sqlglot = None
    _exp = None

# Athena no expone el usuario que ejecutó cada consulta en su API; el "quién" sale
# de CloudTrail (StartQueryExecution → userIdentity + queryExecutionId) y se une por
# queryExecutionId con las stats de Athena (DataScanned = costo, tiempos, el SQL).
# Corre asumiendo el rol del hub (catálogo/datos/historial viven allí). Solo lee
# metadatos (no ejecuta queries) → no cuesta nada de Athena.
HUB_ROLE_ARN = "arn:aws:iam::396913696127:role/gestion-proyectos-cost-reader"
REGION = "us-east-1"
# La resolución de correo→nombre (Identity Center) vive en services/name_directory.
CACHE_TTL = 8 * 3600        # 8h: el historial reciente cambia seguido
RECENT_TTL = 30 * 60        # ventanas que incluyen HOY: el día en curso sigue creciendo
HUNG_AFTER = 20 * 60
_CT_MAX_PAGES = 60          # tope CloudTrail (~3000 consultas por ventana)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TOP_N = 40                 # consultas más pesadas a devolver (global)
_AP_PER_USER = 30           # PATRONES con antipatrones a guardar por usuario (dedup)



def _fingerprint(sql: str) -> str:
    """Huella de la consulta: SQL canónico con los literales enmascarados (`?`), para
    agrupar ejecuciones repetidas del mismo patrón (ej. Tableau corriendo lo mismo
    cientos de veces). Degrada al texto compactado si no parsea."""
    if not sql:
        return ""
    if sqlglot is not None:
        try:
            def _mask(node: Any) -> Any:
                return _exp.Literal(this="?", is_string=False) if isinstance(node, _exp.Literal) else node
            return sqlglot.parse_one(sql, read="athena").transform(_mask).sql(dialect="athena")
        except Exception:
            pass
    return " ".join(sql.split())[:500]


class AthenaMonitorService:
    def __init__(self, repository: AthenaMonitorRepository | None = None) -> None:
        self._db = repository or AthenaMonitorRepository()

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _validate(self, start: str, end: str) -> None:
        if not (_DATE_RE.match(start or "") and _DATE_RE.match(end or "")):
            raise ValidationError("Rango de fechas inválido.")

    def get_usage(self, start: str, end: str, function_name: str | None = None,
                  auto: bool = True, force: bool = False) -> dict[str, Any]:
        self._validate(start, end)
        item = self._db.get_usage(start, end)
        status = (item.get("status") if item else None) or "empty"
        scanned_at = item.get("scannedAt") if item else None
        scanning = status == "scanning" and not self._is_hung(item)
        # `force` (botón "Actualizar") re-escanea aunque el caché esté fresco; igual
        # respeta un escaneo en curso para no duplicarlo.
        if (function_name and not scanning
                and (force or (auto and (not item or status != "ok" or self._is_stale(scanned_at, end))))):
            self.start_scan(start, end, function_name)
            scanning = True
        result = {"start": start, "end": end, "data": item.get("data") if item else None,
                  "scannedAt": scanned_at, "scanning": scanning, "status": status}
        # Ventana recién nacida (p. ej. "últimos 7 días" al cambiar el día): aún no
        # hay nada que mostrar y el primer escaneo tarda 1-2 min (CloudTrail va
        # limitado a ~2 req/s). Mientras corre, se devuelven como PROVISIONALES los
        # datos de la ventana previa más parecida — casi todos los datos coinciden
        # — en vez de dejar la pantalla vacía.
        if scanning and not result["data"]:
            fb = self._fallback_window(start, end)
            if fb:
                result["data"] = fb["data"]
                result["provisional"] = {"start": fb["start"], "end": fb["end"]}
        return result

    def _fallback_window(self, start: str, end: str) -> dict[str, Any] | None:
        """Ventana cacheada más parecida a la pedida (mismo largo en días de
        preferencia, fin más reciente, con datos OK y a lo sumo ~7 días de vieja)."""
        try:
            span = (datetime.fromisoformat(end) - datetime.fromisoformat(start)).days
        except ValueError:
            return None
        best: tuple[int, str, str, str] | None = None   # (penalizacion, end, start, sk)
        for w in self._db.list_usage_windows():
            if w.get("status") != "ok":
                continue
            parts = (w.get("SK") or "").split("#")
            if len(parts) != 2:
                continue
            w_start, w_end = parts
            try:
                w_span = (datetime.fromisoformat(w_end) - datetime.fromisoformat(w_start)).days
                age_days = abs((datetime.fromisoformat(end) - datetime.fromisoformat(w_end)).days)
            except ValueError:
                continue
            if age_days > 7:
                continue
            # Prioriza mismo largo de ventana; luego, la de fin más reciente.
            penalty = abs(w_span - span)
            if best is None or penalty < best[0] or (penalty == best[0] and w_end > best[1]):
                best = (penalty, w_end, w_start, w.get("SK"))
        if not best:
            return None
        full = self._db.get_usage(best[2], best[1])
        if not full or not full.get("data"):
            return None
        return {"data": full["data"], "start": best[2], "end": best[1]}

    def get_query_sql(self, qid: str) -> dict[str, Any]:
        """SQL completo de una consulta por su queryExecutionId (bajo demanda, para
        no guardar el SQL íntegro de todas en el caché). Lee metadatos → gratis."""
        if not re.match(r"^[0-9a-fA-F-]{20,40}$", qid or ""):
            raise ValidationError("Id de consulta inválido.")
        ath = self._session().client("athena")
        q = ath.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        return {"qid": qid, "sql": q.get("Query") or ""}

    def suggest_fix(self, qid: str) -> dict[str, Any]:
        """Sugerencia de un LLM (no la recomendación estática por regla, esa vive
        en el frontend) para UNA consulta concreta: relee el SQL completo por su
        qid (fuente de verdad, no lo que mande el cliente), vuelve a analizarla con
        `_lint_sql` para tener los antipatrones reales y el catálogo (particiones,
        formato) de las tablas involucradas, y se lo da todo como contexto al
        modelo. Si el query no tiene antipatrones, no llama al LLM (nada que
        sugerir)."""
        sql = self.get_query_sql(qid)["sql"]
        # Contexto de catálogo compartido con el chat (services/sql_context.py):
        # tablas del query → formato/particiones/columnas con tipo, y resolución de
        # tablas SIN base contra las bases cacheadas. Sus lecturas memoizadas sirven
        # también de callbacks para el lint.
        ctx = SqlCatalogContext()
        lint = _lint_sql(sql, get_partcols=ctx.get_partcols, get_format=ctx.get_format)
        issues = lint["issues"]
        if not issues:
            return {"qid": qid, "suggestion": "", "issues": []}
        ctx.add_sql(sql)
        resolution_notes = ctx.notes

        labels = [_ANTIPATTERNS.get(i["code"], i["code"]) for i in issues]
        catalog_block = ctx.catalog_block() or "(sin datos de catálogo disponibles)"

        system = (
            "Eres un experto en optimizar consultas SQL para Amazon Athena (motor "
            "Presto/Trino). Respondes en español técnico, claro y breve (máximo "
            "6-8 líneas). Te basas SOLO en el SQL y el catálogo que te dan — nunca "
            "inventes columnas, tablas, tipos o particiones que no aparezcan ahí. "
            "Usa el tipo real de cada columna (viene en el catálogo) para precisar "
            "la sugerencia, por ejemplo al detectar conversiones de tipo "
            "innecesarias. Athena NO usa índices (escanea archivos en S3): explica "
            "los problemas en términos de partition pruning, estadísticas de "
            "Parquet (min/max por bloque) y datos escaneados — nunca digas que "
            "algo 'impide usar índices'. Para un LIKE con comodín al inicio "
            "('%x%'), lo mejor es igualdad o IN con los valores reales del campo "
            "si son conocidos; si no, anclar el prefijo ('x%'); conservar '%x%' "
            "solo si de verdad se busca texto en cualquier posición. En el SQL "
            "corregido usa SIEMPRE nombres reales del catálogo: si te indican la "
            "base real de una tabla, califícala con esa base (nunca marcadores "
            "como 'tu_esquema'); al reemplazar SELECT *, propón una lista "
            "concreta con las columnas que el query ya usa (WHERE/JOIN/ORDER) más "
            "las del catálogo que parezcan relevantes al propósito, aclarando en "
            "una línea que el usuario ajuste esa lista a lo que realmente "
            "necesita. REGLA DE COHERENCIA: todo problema que menciones debe "
            "quedar corregido en el SQL que propongas; si decides no corregir "
            "alguno, di explícitamente por qué lo dejaste igual. IMPORTANTE: si "
            "el query es largo (más de ~30 líneas), NO lo reescribas completo — "
            "muestra SOLO los fragmentos que cambian (cada uno con 1-2 líneas de "
            "contexto e indicando en qué parte va); el usuario aplica los cambios "
            "sobre su query original.")
        resolution_block = ("\n\nTablas resueltas contra el catálogo:\n" + "\n".join(resolution_notes)) if resolution_notes else ""
        prompt = (
            f"Consulta SQL:\n```sql\n{sql}\n```\n\n"
            f"Antipatrones detectados automáticamente: {', '.join(labels)}.\n\n"
            f"Catálogo de las tablas referenciadas:\n{catalog_block}"
            f"{resolution_block}\n\n"
            "Da una sugerencia concreta para ESTA consulta en particular (no una "
            "explicación genérica del antipatrón), teniendo en cuenta la "
            "estructura real del query y el catálogo de arriba.")
        # Tope de salida calibrado contra el timeout DURO de API Gateway (30 s, no
        # configurable): generar ~2500 tokens tardaba >30 s en queries grandes y el
        # navegador recibía el corte aunque la Lambda terminara bien. Por eso el
        # prompt pide fragmentos (no reescribir el query completo) y el tope queda
        # en un punto que da respuestas completas en <20 s.
        # thinking=False: GLM 5 razona antes de responder y con queries grandes eso
        # puede superar los 30 s del timeout de API Gateway; para esta tarea acotada
        # la respuesta directa es suficiente.
        result = LlmService().complete(prompt, system=system, max_tokens=1400, thinking=False)
        suggestion = result["text"]
        if result.get("stopReason") == "max_tokens":
            suggestion += "\n\n*(La sugerencia se cortó por longitud; pide de nuevo enfocándote en una parte del query.)*"
        return {"qid": qid, "suggestion": suggestion, "issues": issues}

    def start_scan(self, start: str, end: str, function_name: str) -> dict[str, Any]:
        self._validate(start, end)
        self._db.set_status(start, end, "scanning", self._now())
        boto3.client("lambda").invoke(
            FunctionName=function_name, InvocationType="Event",
            Payload=json.dumps({"action": "athena_usage_scan", "start": start, "end": end}).encode())
        return {"scanning": True}

    def run_scan(self, start: str, end: str) -> None:
        """Escaneo INCREMENTAL: primero ingesta (solo lo que falta de CloudTrail/
        Athena, con lint memoizado) y luego agrega la ventana desde los items ya
        guardados — los refrescos y cambios de rango no re-traen ni re-parsean."""
        self._validate(start, end)
        now = self._now()
        try:
            self._ingest(start, end)
            data, user_ap = self._aggregate(start, end)
            self._db.put_usage(start, end, data, now, "ok")
            self._db.put_user_antipatterns(start, end, user_ap, now)
        except Exception:
            self._db.set_status(start, end, "error", now)
            raise

    def get_user_antipatterns(self, start: str, end: str, user: str) -> dict[str, Any]:
        """Consultas con antipatrones de UN usuario (drill bajo demanda). Lee el item
        por-usuario que dejó el escaneo; no recalcula."""
        self._validate(start, end)
        if not user:
            raise ValidationError("Usuario requerido.")
        item = self._db.get_user_antipatterns(start, end, user)
        return {"user": user, "queries": (item.get("queries") if item else None) or []}

    # ── Frescura ──────────────────────────────────────────────────────────────
    def _is_stale(self, scanned_at: Any, end: str | None = None) -> bool:
        age = self._age(scanned_at)
        if age is None:
            return True
        # Si la ventana incluye HOY, el día en curso aún cambia → TTL corto para que
        # los rangos converjan; las ventanas ya cerradas (fin < hoy) conservan el largo.
        ttl = RECENT_TTL if self._includes_today(end) else CACHE_TTL
        return age > ttl

    def _includes_today(self, end: str | None) -> bool:
        if not end:
            return False
        return end >= datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def _is_hung(self, item: dict[str, Any] | None) -> bool:
        if not item:
            return False
        age = self._age(item.get("startedAt") or item.get("scannedAt"))
        return age is None or age > HUNG_AFTER

    def _age(self, iso: Any) -> float | None:
        if not iso:
            return None
        try:
            dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None
        return (datetime.now(timezone.utc) - dt).total_seconds()

    # ── Cómputo (CloudTrail + Athena, asumiendo el rol del hub) ─────────────────
    def _session(self):
        creds = boto3.client("sts").assume_role(
            RoleArn=HUB_ROLE_ARN, RoleSessionName="gp-athena-monitor")["Credentials"]
        return boto3.Session(
            aws_access_key_id=creds["AccessKeyId"], aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"], region_name=REGION)

    def _actor(self, ui: dict[str, Any]) -> str:
        """Persona/identidad real. SSO/AssumedRole → email de la sesión si lo hay;
        si no (roles de servicio), el nombre del rol."""
        if ui.get("type") == "IAMUser":
            return ui.get("userName") or "IAMUser"
        arn = ui.get("arn") or ""
        sess = arn.rsplit("/", 1)[-1] if "/" in arn else ""
        role = ui.get("sessionContext", {}).get("sessionIssuer", {}).get("userName") or ""
        if "@" in sess:   # SSO: el nombre de sesión es el email de la persona
            return sess
        return role or sess or ui.get("type") or "desconocido"

    def _resolve_names(self, actors: list[str]) -> dict[str, str]:
        """{actor(email) -> nombre}; la lógica vive en NameDirectory (compartida con
        el autor del seguimiento de Solicitudes), reusando la misma caché."""
        return NameDirectory(self._db).resolve(actors)

    # ── Ingesta incremental (CloudTrail + Athena, asumiendo el rol del hub) ────
    _INGEST_OVERLAP = 2 * 3600      # re-lee el borde: eventos/finales que llegan tarde
    _EXEC_TTL_DAYS = 45             # = retención de stats de Athena

    def _fetch_cloudtrail(self, ct: Any, start_dt: Any, end_dt: Any) -> dict[str, dict[str, str]]:
        """queryExecutionId -> {usuario, workgroup} en el rango. CloudTrail limita a
        ~2 req/s por cuenta (throttling del lado AWS) → paralelizar NO ayuda; por eso
        la ingesta incremental: este costo se paga UNA vez por rango nuevo."""
        qid_meta: dict[str, dict[str, str]] = {}
        token = None
        pages = 0
        while True:
            kw: dict[str, Any] = dict(
                LookupAttributes=[{"AttributeKey": "EventName", "AttributeValue": "StartQueryExecution"}],
                StartTime=start_dt, EndTime=end_dt, MaxResults=50)
            if token:
                kw["NextToken"] = token
            r = ct.lookup_events(**kw)
            for ev in r.get("Events", []):
                try:
                    e = json.loads(ev["CloudTrailEvent"])
                except Exception:
                    continue
                qid = (e.get("responseElements") or {}).get("queryExecutionId")
                if not qid:
                    continue
                qid_meta[qid] = {
                    "user": self._actor(e.get("userIdentity", {})),
                    "wg": (e.get("requestParameters") or {}).get("workGroup") or "",
                }
            token = r.get("NextToken")
            pages += 1
            if not token or pages >= _CT_MAX_PAGES:
                break
        return qid_meta

    def _ingest(self, start: str, end: str) -> None:
        """Trae SOLO los rangos aún no ingeridos (cursor [from, to] en DynamoDB, con
        2h de solapamiento en el borde) y guarda un item por ejecución con su lint
        YA calculado. Idempotente: re-escribir la misma ejecución es un overwrite."""
        sess = self._session()
        ct = sess.client("cloudtrail")
        ath = sess.client("athena")
        now_dt = datetime.now(timezone.utc)
        start_dt = datetime.fromisoformat(start + "T00:00:00+00:00")
        end_dt = min(datetime.fromisoformat(end + "T23:59:59+00:00"), now_dt)
        if end_dt <= start_dt:
            return

        cur = self._db.get_ingest_cursor() or {}
        ranges: list[tuple[Any, Any]] = []
        try:
            cur_from = datetime.fromisoformat(str(cur.get("from")))
            cur_to = datetime.fromisoformat(str(cur.get("to")))
        except (ValueError, TypeError):
            cur_from = cur_to = None
        if cur_from and cur_to:
            if start_dt < cur_from:                       # backfill hacia atrás (rango más viejo)
                ranges.append((start_dt, cur_from))
            edge = cur_to - timedelta(seconds=self._INGEST_OVERLAP)
            if end_dt > edge:                             # lo nuevo desde el último cursor
                ranges.append((max(edge, start_dt), end_dt))
            new_from, new_to = min(start_dt, cur_from), max(end_dt, cur_to)
        else:
            ranges.append((start_dt, end_dt))
            new_from, new_to = start_dt, end_dt

        qid_meta: dict[str, dict[str, str]] = {}
        for a, b in ranges:
            if b > a:
                qid_meta.update(self._fetch_cloudtrail(ct, a, b))
        if qid_meta:
            self._db.put_executions(self._build_exec_items(ath, qid_meta))
        self._db.put_ingest_cursor(new_from.isoformat(), new_to.isoformat(), self._now())

    def _build_exec_items(self, ath: Any, qid_meta: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
        """Stats + SQL por qid (batches de 50 EN PARALELO — I/O libera el GIL) y el
        lint por ejecución. El lint se MEMOIZA por texto SQL idéntico (las
        herramientas BI repiten el mismo query cientos de veces) y se salta en
        sentencias UTILITY (SHOW/DESCRIBE: nada que detectar)."""
        cat = CatalogRepository()
        _tcache: dict[tuple[str, str], dict[str, Any]] = {}

        def _table_meta(db: str, table: str) -> dict[str, Any]:
            key = (db, table)
            if key not in _tcache:
                try:
                    _tcache[key] = cat.get_catalog_table(db, table) or {}
                except Exception:
                    _tcache[key] = {}
            return _tcache[key]

        def get_partcols(db: str, table: str) -> Any:
            return _table_meta(db, table).get("partitionKeys") or None

        def get_format(db: str, table: str) -> str:
            return _table_meta(db, table).get("format") or ""

        ids = list(qid_meta)
        chunks = [ids[i:i + 50] for i in range(0, len(ids), 50)]

        def _fetch_chunk(chunk: list[str]) -> list[dict[str, Any]]:
            try:
                return ath.batch_get_query_execution(QueryExecutionIds=chunk).get("QueryExecutions", [])
            except Exception:
                return []

        executions: list[dict[str, Any]] = []
        if chunks:
            with ThreadPoolExecutor(max_workers=min(8, len(chunks))) as pool:
                for res in pool.map(_fetch_chunk, chunks):
                    executions.extend(res)

        _EMPTY = {"issues": [], "marks": [], "marksByCode": {}, "tables": []}
        lint_memo: dict[str, dict[str, Any]] = {}
        fp_memo: dict[str, str] = {}
        ttl = int(datetime.now(timezone.utc).timestamp()) + self._EXEC_TTL_DAYS * 86400
        items: list[dict[str, Any]] = []
        for q in executions:
            state = q.get("Status", {}).get("State", "")
            if state not in ("SUCCEEDED", "FAILED", "CANCELLED"):
                continue        # aún corriendo: la recogerá el solapamiento del próximo scan
            qid = q.get("QueryExecutionId") or ""
            meta = qid_meta.get(qid, {})
            st = q.get("Statistics", {})
            sub = q.get("Status", {}).get("SubmissionDateTime")
            sub_iso = sub.isoformat() if sub else ""
            if not qid or not sub_iso:
                continue
            sql = (q.get("Query") or "").strip()
            stype = q.get("StatementType", "")
            if stype == "UTILITY" or not sql:
                lint = _EMPTY
                fp = sql
            else:
                lint = lint_memo.get(sql)
                if lint is None:
                    lint = _lint_sql(sql, get_partcols, get_format)
                    lint_memo[sql] = lint
                fp = fp_memo.get(sql)
                if fp is None:
                    fp = _fingerprint(sql)
                    fp_memo[sql] = fp
            items.append({
                "PK": "ATHENA#EXEC", "SK": f"{sub_iso}#{qid}", "entityType": "ATHENA_EXEC",
                "qid": qid, "user": meta.get("user", "desconocido"), "wg": meta.get("wg", ""),
                "bytes": int(st.get("DataScannedInBytes", 0) or 0),
                "ms": int(st.get("TotalExecutionTimeInMillis", 0) or 0),
                "sub": sub_iso, "statementType": stype,
                "sql": sql[:600], "fp": fp,
                "issues": lint["issues"], "marks": lint["marks"],
                "marksByCode": lint["marksByCode"],
                "tables": [list(t) for t in (lint.get("tables") or [])],
                "ttl": ttl,      # expira solo (TTL nativo, mismo atributo que el chat)
            })
        return items

    # ── Agregación por ventana (solo DynamoDB: sin AWS del hub, sin re-parseo) ─
    def _aggregate(self, start: str, end: str) -> tuple[dict[str, Any], dict[str, list]]:
        rows = self._db.query_executions(start, end)
        users: dict[str, dict[str, Any]] = {}
        top: list[dict[str, Any]] = []
        user_ap: dict[str, dict[str, dict[str, Any]]] = {}   # user -> {huella -> patrón}
        table_usage: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
        for row in rows:
            user = row.get("user", "desconocido")
            b = int(row.get("bytes", 0) or 0)
            ms = int(row.get("ms", 0) or 0)
            sub_iso = row.get("sub", "")
            issues = row.get("issues") or []
            for t in row.get("tables") or []:
                tkey = (str(t[0]), str(t[1]))
                rec = table_usage.setdefault(tkey, {}).setdefault(user, {"count": 0, "lastRun": ""})
                rec["count"] += 1
                if sub_iso > rec["lastRun"]:
                    rec["lastRun"] = sub_iso
            u = users.setdefault(user, {
                "user": user, "queries": 0, "bytes": 0, "totalMs": 0, "maxMs": 0,
                "antipatterns": 0, "issueCounts": {}})
            u["queries"] += 1
            u["bytes"] += b
            u["totalMs"] += ms
            if ms > u["maxMs"]:
                u["maxMs"] = ms
            item = {
                "qid": row.get("qid"),
                "user": user, "bytes": b, "ms": ms, "wg": row.get("wg", ""),
                "lastRun": sub_iso,
                "issues": issues,
                "marks": row.get("marks") or [],
                "marksByCode": row.get("marksByCode") or {},
                "statementType": row.get("statementType", ""),
                "sql": row.get("sql", ""),
            }
            top.append(item)
            if issues:
                u["antipatterns"] += 1
                for it in issues:
                    u["issueCounts"][it["code"]] = u["issueCounts"].get(it["code"], 0) + 1
                fp = row.get("fp") or item["sql"]
                bucket = user_ap.setdefault(user, {})
                pat = bucket.get(fp)
                if pat is None:
                    pat = {"qid": item["qid"], "wg": item["wg"], "count": 0,
                           "bytes": 0, "maxBytes": 0, "ms": 0, "lastRun": "",
                           "issues": issues, "marks": item["marks"],
                           "marksByCode": item["marksByCode"], "sql": item["sql"]}
                    bucket[fp] = pat
                pat["count"] += 1
                pat["bytes"] += b
                if sub_iso > pat["lastRun"]:
                    pat["lastRun"] = sub_iso
                if b >= pat["maxBytes"]:
                    pat["maxBytes"] = b
                    pat["qid"], pat["sql"], pat["marks"], pat["marksByCode"], pat["issues"] = (
                        item["qid"], item["sql"], item["marks"], item["marksByCode"], issues)
                if ms > pat["ms"]:
                    pat["ms"] = ms

        top.sort(key=lambda x: x["bytes"], reverse=True)
        users_list = sorted(users.values(), key=lambda x: x["bytes"], reverse=True)
        names = self._resolve_names([u["user"] for u in users_list])
        for u in users_list:
            if names.get(u["user"]):
                u["name"] = names[u["user"]]
        for item in top:
            if names.get(item["user"]):
                item["name"] = names[item["user"]]
        user_pat: dict[str, list[dict[str, Any]]] = {}
        for usr, bucket in user_ap.items():
            user_pat[usr] = sorted(bucket.values(), key=lambda x: x["bytes"], reverse=True)[:_AP_PER_USER]
        # Índice de uso por tabla → "Uso reciente" del Catálogo (la ventana
        # agregada más reciente sobreescribe).
        usage_items: list[dict[str, Any]] = []
        usage_at = self._now()
        # Las consultas escaneadas corren contra el Athena del hub, así que el
        # índice se escribe en el namespace de esa cuenta (la default del catálogo).
        usage_repo = CatalogRepository()
        for (db, table), by_user in table_usage.items():
            urows = [{"user": usr, "name": names.get(usr, ""),
                      "count": rec["count"], "lastRun": rec["lastRun"]}
                     for usr, rec in by_user.items()]
            urows.sort(key=lambda r: r["lastRun"], reverse=True)
            usage_items.append({
                "PK": usage_repo.table_entity_pk(db, table), "SK": "USAGE", "entityType": "TABLE_USAGE",
                "database": db, "table": table, "users": urows[:20],
                "start": start, "end": end, "scannedAt": usage_at,
            })
        if usage_items:
            try:
                usage_repo.put_table_usage_bulk(usage_items)
            except Exception:
                pass        # el índice de uso nunca debe tumbar el escaneo principal
        data = {
            "start": start, "end": end,
            "users": users_list, "topQueries": top[:_TOP_N],
            "totalQueries": sum(u["queries"] for u in users_list),
            "totalBytes": sum(u["bytes"] for u in users_list),
        }
        return data, user_pat
