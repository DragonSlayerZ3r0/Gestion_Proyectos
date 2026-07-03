import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

import boto3

from core.errors import ValidationError
from repositories.athena_monitor import AthenaMonitorRepository
from repositories.catalog import CatalogRepository
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
# Identity Center (cuenta de la app): mapea usrNNNNN@/nombre.apellido@ → nombre real
# de CUALQUIER usuario institucional, esté o no registrado en la app.
IDENTITY_STORE_ID = "d-90662bac01"
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
        self._validate(start, end)
        now = self._now()
        try:
            data, user_ap = self._compute(start, end)
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
        """{actor(email) -> nombre} vía Identity Center, con caché en DynamoDB. Solo
        resuelve los que faltan (los positivos quedan cacheados → casi sin llamadas)."""
        cache = self._db.get_name_map()
        missing = [a for a in dict.fromkeys(actors) if "@" in a and a not in cache]
        if missing:
            ids = boto3.client("identitystore", region_name=REGION)  # cuenta de la app
            for a in missing:
                nm = self._lookup_identity(ids, a)
                if nm:
                    cache[a] = nm
            self._db.put_name_map(cache)
        return cache

    def _lookup_identity(self, ids: Any, actor: str) -> str:
        """Nombre de un usuario por su userName (usrNNNNN@) o su email (nombre.apellido@)."""
        for path in ("userName", "emails.value"):
            try:
                uid = ids.get_user_id(
                    IdentityStoreId=IDENTITY_STORE_ID,
                    AlternateIdentifier={"UniqueAttribute": {"AttributePath": path, "AttributeValue": actor}},
                )["UserId"]
            except Exception:
                continue
            try:
                return ids.describe_user(IdentityStoreId=IDENTITY_STORE_ID, UserId=uid).get("DisplayName") or ""
            except Exception:
                return ""
        return ""

    def _compute(self, start: str, end: str) -> tuple[dict[str, Any], dict[str, list]]:
        sess = self._session()
        ct = sess.client("cloudtrail")
        ath = sess.client("athena")
        start_dt = datetime.fromisoformat(start + "T00:00:00+00:00")
        end_dt = datetime.fromisoformat(end + "T23:59:59+00:00")

        # 1) CloudTrail: queryExecutionId -> {usuario, workgroup}
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

        # 2) Athena: stats + SQL por queryExecutionId (batch de 50)
        ids = list(qid_meta)
        users: dict[str, dict[str, Any]] = {}
        top: list[dict[str, Any]] = []
        user_ap: dict[str, dict[str, dict[str, Any]]] = {}   # user -> {huella -> patrón}
        # Particiones desde el catálogo cacheado (DynamoDB), memoizado por (db, tabla);
        # NO toca Glue. Si la tabla no está sincronizada → None (no se marca).
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

        # 2b) Trae los lotes de 50 EN PARALELO (I/O-bound, libera el GIL durante la
        # llamada de red) — antes eran secuenciales y ahí se iba la mayor parte del
        # tiempo del scan. El boto3 client es thread-safe para hacer llamadas.
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

        # El lint (sqlglot) y el resto del armado sí quedan secuenciales: mutan
        # diccionarios compartidos (`users`, `user_ap`) y son CPU, no I/O.
        for q in executions:
            meta = qid_meta.get(q.get("QueryExecutionId"), {})
            user = meta.get("user", "desconocido")
            st = q.get("Statistics", {})
            b = int(st.get("DataScannedInBytes", 0) or 0)
            ms = int(st.get("TotalExecutionTimeInMillis", 0) or 0)
            sub = q.get("Status", {}).get("SubmissionDateTime")
            sub_iso = sub.isoformat() if sub else ""   # cuándo se ejecutó
            sql = (q.get("Query") or "").strip()
            lint = _lint_sql(sql, get_partcols, get_format)
            issues = lint["issues"]
            u = users.setdefault(user, {
                "user": user, "queries": 0, "bytes": 0, "totalMs": 0, "maxMs": 0,
                "antipatterns": 0, "issueCounts": {}})
            u["queries"] += 1
            u["bytes"] += b
            u["totalMs"] += ms
            if ms > u["maxMs"]:
                u["maxMs"] = ms
            item = {
                "qid": q.get("QueryExecutionId"),
                "user": user, "bytes": b, "ms": ms, "wg": meta.get("wg", ""),
                "lastRun": sub_iso,        # última ejecución (para ordenar por reciente)
                "issues": issues,          # antipatrones detectados (badges)
                "marks": lint["marks"],    # tramos a resaltar en rojo (sobre el SQL completo)
                "marksByCode": lint["marksByCode"],  # tramos por antipatrón (resaltado selectivo)
                "statementType": q.get("StatementType", ""),
                "sql": sql[:600],          # vista previa; el SQL completo se trae bajo demanda
            }
            top.append(item)
            if issues:
                u["antipatterns"] += 1
                for it in issues:
                    u["issueCounts"][it["code"]] = u["issueCounts"].get(it["code"], 0) + 1
                # Dedup por huella: agrupa ejecuciones repetidas del MISMO patrón
                # (ej. Tableau corriendo lo mismo cientos de veces).
                fp = _fingerprint(sql)
                bucket = user_ap.setdefault(user, {})
                pat = bucket.get(fp)
                if pat is None:
                    pat = {"qid": item["qid"], "wg": item["wg"], "count": 0,
                           "bytes": 0, "maxBytes": 0, "ms": 0, "lastRun": "",
                           "issues": issues, "marks": lint["marks"],
                           "marksByCode": lint["marksByCode"], "sql": item["sql"]}
                    bucket[fp] = pat
                pat["count"] += 1
                pat["bytes"] += b               # total escaneado por el patrón (impacto)
                if sub_iso > pat["lastRun"]:    # última ejecución del patrón
                    pat["lastRun"] = sub_iso
                if b >= pat["maxBytes"]:        # representante = ejecución más pesada
                    pat["maxBytes"] = b
                    pat["qid"], pat["sql"], pat["marks"], pat["marksByCode"], pat["issues"] = (
                        item["qid"], item["sql"], lint["marks"], lint["marksByCode"], issues)
                if ms > pat["ms"]:
                    pat["ms"] = ms

        top.sort(key=lambda x: x["bytes"], reverse=True)
        users_list = sorted(users.values(), key=lambda x: x["bytes"], reverse=True)
        # Resuelve el NOMBRE real desde AWS Identity Center (cubre a TODOS los
        # institucionales, no solo los registrados en la app). Cacheado en DynamoDB.
        names = self._resolve_names([u["user"] for u in users_list])
        for u in users_list:
            if names.get(u["user"]):
                u["name"] = names[u["user"]]
        for item in top:
            if names.get(item["user"]):
                item["name"] = names[item["user"]]
        # Por usuario: PATRONES (dedup) ordenados por escaneo TOTAL, acotados. Se guardan
        # en items aparte (uno por usuario) → escala con la cantidad de gente.
        user_pat: dict[str, list[dict[str, Any]]] = {}
        for usr, bucket in user_ap.items():
            user_pat[usr] = sorted(bucket.values(), key=lambda x: x["bytes"], reverse=True)[:_AP_PER_USER]
        data = {
            "start": start, "end": end,
            "users": users_list, "topQueries": top[:_TOP_N],
            "totalQueries": sum(u["queries"] for u in users_list),
            "totalBytes": sum(u["bytes"] for u in users_list),
        }
        return data, user_pat
