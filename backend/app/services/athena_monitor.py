import json
import re
from datetime import datetime, timezone
from typing import Any

import boto3

from core.errors import ValidationError
from repositories.athena_monitor import AthenaMonitorRepository

# Athena no expone el usuario que ejecutó cada consulta en su API; el "quién" sale
# de CloudTrail (StartQueryExecution → userIdentity + queryExecutionId) y se une por
# queryExecutionId con las stats de Athena (DataScanned = costo, tiempos, el SQL).
# Corre asumiendo el rol del hub (catálogo/datos/historial viven allí). Solo lee
# metadatos (no ejecuta queries) → no cuesta nada de Athena.
HUB_ROLE_ARN = "arn:aws:iam::396913696127:role/gestion-proyectos-cost-reader"
REGION = "us-east-1"
CACHE_TTL = 8 * 3600        # 8h: el historial reciente cambia seguido
HUNG_AFTER = 20 * 60
_CT_MAX_PAGES = 60          # tope CloudTrail (~3000 consultas por ventana)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SELECT_STAR = re.compile(r"select\s+\*", re.I)
_TOP_N = 40                 # consultas más pesadas a devolver


class AthenaMonitorService:
    def __init__(self, repository: AthenaMonitorRepository | None = None) -> None:
        self._db = repository or AthenaMonitorRepository()

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _validate(self, start: str, end: str) -> None:
        if not (_DATE_RE.match(start or "") and _DATE_RE.match(end or "")):
            raise ValidationError("Rango de fechas inválido.")

    def get_usage(self, start: str, end: str, function_name: str | None = None,
                  auto: bool = True) -> dict[str, Any]:
        self._validate(start, end)
        item = self._db.get_usage(start, end)
        status = (item.get("status") if item else None) or "empty"
        scanned_at = item.get("scannedAt") if item else None
        scanning = status == "scanning" and not self._is_hung(item)
        if (auto and function_name and not scanning
                and (not item or status != "ok" or self._is_stale(scanned_at))):
            self.start_scan(start, end, function_name)
            scanning = True
        return {"start": start, "end": end, "data": item.get("data") if item else None,
                "scannedAt": scanned_at, "scanning": scanning, "status": status}

    def get_query_sql(self, qid: str) -> dict[str, Any]:
        """SQL completo de una consulta por su queryExecutionId (bajo demanda, para
        no guardar el SQL íntegro de todas en el caché). Lee metadatos → gratis."""
        if not re.match(r"^[0-9a-fA-F-]{20,40}$", qid or ""):
            raise ValidationError("Id de consulta inválido.")
        ath = self._session().client("athena")
        q = ath.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
        return {"qid": qid, "sql": q.get("Query") or ""}

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
            data = self._compute(start, end)
            self._db.put_usage(start, end, data, now, "ok")
        except Exception:
            self._db.set_status(start, end, "error", now)
            raise

    # ── Frescura ──────────────────────────────────────────────────────────────
    def _is_stale(self, scanned_at: Any) -> bool:
        age = self._age(scanned_at)
        return age is None or age > CACHE_TTL

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

    def _compute(self, start: str, end: str) -> dict[str, Any]:
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
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            try:
                res = ath.batch_get_query_execution(QueryExecutionIds=chunk).get("QueryExecutions", [])
            except Exception:
                res = []
            for q in res:
                meta = qid_meta.get(q.get("QueryExecutionId"), {})
                user = meta.get("user", "desconocido")
                st = q.get("Statistics", {})
                b = int(st.get("DataScannedInBytes", 0) or 0)
                ms = int(st.get("TotalExecutionTimeInMillis", 0) or 0)
                sql = (q.get("Query") or "").strip()
                star = bool(_SELECT_STAR.search(sql))
                u = users.setdefault(user, {
                    "user": user, "queries": 0, "bytes": 0, "totalMs": 0, "maxMs": 0, "selectStar": 0})
                u["queries"] += 1
                u["bytes"] += b
                u["totalMs"] += ms
                if ms > u["maxMs"]:
                    u["maxMs"] = ms
                if star:
                    u["selectStar"] += 1
                top.append({
                    "qid": q.get("QueryExecutionId"),
                    "user": user, "bytes": b, "ms": ms, "wg": meta.get("wg", ""),
                    "selectStar": star, "statementType": q.get("StatementType", ""),
                    "sql": sql[:600],   # vista previa; el SQL completo se trae bajo demanda
                })

        top.sort(key=lambda x: x["bytes"], reverse=True)
        users_list = sorted(users.values(), key=lambda x: x["bytes"], reverse=True)
        return {
            "start": start, "end": end,
            "users": users_list, "topQueries": top[:_TOP_N],
            "totalQueries": sum(u["queries"] for u in users_list),
            "totalBytes": sum(u["bytes"] for u in users_list),
        }
