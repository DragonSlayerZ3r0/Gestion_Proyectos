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

# Antipatrones de SQL que encarecen/lentifican Athena. code -> etiqueta (badge).
_ANTIPATTERNS = {
    "select_star": "SELECT *",
    "tabla_sin_db": "tabla sin base de datos",
    "sin_where": "sin filtro WHERE",
    "sin_particion": "sin filtro de partición",
    "order_sin_limit": "ORDER BY sin LIMIT",
    "cross_join": "CROSS JOIN / JOIN sin ON",
    "like_comodin": "LIKE con comodín al inicio",
    "union_dedup": "UNION (usa UNION ALL)",
    "func_en_filtro": "función sobre columna en filtro",
    "cast_en_filtro": "conversión de tipo en filtro",
    "subquery_repetida": "subconsulta/CTE repetida",
    "formato_no_columnar": "formato no columnar (CSV/JSON)",
    "no_parse": "no se pudo analizar",
}


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


def _bbox(node: Any) -> tuple[int | None, int | None]:
    """Caja delimitadora aproximada: min/max de las posiciones de TODOS los nodos
    descendientes con meta propia. Sirve de respaldo para nodos compuestos (Cast,
    Subquery) que no cargan su propia posición en sqlglot."""
    lo = hi = None
    for n in node.walk():
        m = getattr(n, "meta", None) or {}
        a, b = m.get("start"), m.get("end")
        if isinstance(a, int) and isinstance(b, int):
            lo = a if lo is None else min(lo, a)
            hi = b if hi is None else max(hi, b)
    return lo, hi


def _paren_span(sql: str, lo: int, hi: int) -> tuple[int, int] | None:
    """Paréntesis más angosto que envuelve [lo, hi] en el texto crudo. Con esto un
    `CAST(...)` o una subconsulta `(SELECT ...)` se resaltan completos, no solo la
    columna interna (aproximación de `_bbox`, sin posición propia en el AST).
    Ignora paréntesis dentro de strings ('...', con '' como escape)."""
    best: tuple[int, int] | None = None
    stack: list[int] = []
    in_str = False
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        if in_str:
            if c == "'":
                if i + 1 < n and sql[i + 1] == "'":
                    i += 2
                    continue
                in_str = False
        else:
            if c == "'":
                in_str = True
            elif c == "(":
                stack.append(i)
            elif c == ")":
                if stack:
                    a = stack.pop()
                    if a <= lo and hi <= i and (best is None or (i - a) < (best[1] - best[0])):
                        best = (a, i)
        i += 1
    return best


def _lint_sql(sql: str, get_partcols: Any = None, get_format: Any = None) -> dict[str, Any]:
    """Detecta antipatrones en el SQL por AST (sqlglot, dialecto athena).
    Devuelve {issues:[{code,label}], marks:[[start,end],...]} con rangos de
    caracteres (inclusivos) sobre `sql` para resaltar lo problemático en rojo.
    `get_partcols(db, table) -> list[str]|None` permite marcar "sin filtro de
    partición" y `get_format(db, table) -> str` "formato no columnar", ambos
    usando el catálogo cacheado (sin tocar Glue). Nunca lanza: si el vendor
    falta o el SQL no parsea, degrada con elegancia."""
    if not sql or sqlglot is None:
        return {"issues": [], "marks": [], "marksByCode": {}}
    issues: list[dict[str, str]] = []
    marks: list[list[int]] = []
    marks_by_code: dict[str, list[list[int]]] = {}
    seen: set[str] = set()

    def add(code: str) -> None:
        if code not in seen:
            seen.add(code)
            issues.append({"code": code, "label": _ANTIPATTERNS.get(code, code)})

    def mark(node: Any, code: str) -> None:
        m = getattr(node, "meta", None) or {}
        a, b = m.get("start"), m.get("end")
        if not (isinstance(a, int) and isinstance(b, int) and b >= a):
            # Algunos nodos compuestos (Cast, Subquery) no cargan su propia posición
            # en sqlglot: se aproxima con la caja delimitadora de sus descendientes,
            # extendida al paréntesis que los envuelve si aplica (p. ej. resalta
            # `CAST(col AS ...)` o `(SELECT ...)` completos, no solo la columna).
            lo, hi = _bbox(node)
            if lo is not None and hi is not None:
                span = _paren_span(sql, lo, hi)
                a, b = span if span else (lo, hi)
        if isinstance(a, int) and isinstance(b, int) and b >= a:
            marks.append([a, b])
            marks_by_code.setdefault(code, []).append([a, b])

    try:
        tree = sqlglot.parse_one(sql, read="athena")
    except Exception:
        return {"issues": [{"code": "no_parse", "label": _ANTIPATTERNS["no_parse"]}], "marks": [], "marksByCode": {}}

    ctes = {c.alias_or_name.lower() for c in tree.find_all(_exp.CTE)}
    # 1) SELECT * en la proyección (no confundir con count(*))
    for star in tree.find_all(_exp.Star):
        p = star.parent
        if isinstance(p, _exp.Select) or (isinstance(p, _exp.Column) and isinstance(p.parent, _exp.Select)):
            add("select_star"); mark(star, "select_star")
    # 2) tabla referenciada sin base de datos (excluye CTEs y subconsultas).
    #    La posición vive en el identificador (t.this), no en el nodo Table.
    for t in tree.find_all(_exp.Table):
        if not t.db and t.name and t.name.lower() not in ctes:
            add("tabla_sin_db"); mark(t.this if t.this is not None else t, "tabla_sin_db")
    # 3) SELECT sobre tabla real sin WHERE (posible escaneo completo). Se marca la
    # tabla en el FROM (igual que "sin_particion") para ubicar dónde falta el filtro
    # aunque el query sea largo.
    sel = tree.find(_exp.Select)
    if sel and sel.find(_exp.From) and not sel.args.get("where"):
        real_tables = [s for s in sel.find_all(_exp.Table) if (s.name or "").lower() not in ctes]
        if real_tables:
            add("sin_where")
            mark(real_tables[0].this if real_tables[0].this is not None else real_tables[0], "sin_where")
    # 4) ORDER BY sin LIMIT (ordena todo el resultado). Se excluye el ORDER BY
    #    de una función de ventana (ROW_NUMBER() OVER (... ORDER BY ...)): ese no
    #    ordena el resultado completo, solo define el orden dentro de cada partición.
    def _in_window(node: Any) -> bool:
        p = node.parent
        while p is not None:
            if isinstance(p, _exp.Window):
                return True
            p = p.parent
        return False

    order = next((o for o in tree.find_all(_exp.Order) if not _in_window(o)), None)
    if order and not tree.find(_exp.Limit):
        add("order_sin_limit"); mark(order, "order_sin_limit")
    # 5) CROSS JOIN / JOIN sin ON (producto cartesiano). UNNEST/LATERAL son legítimos.
    for j in tree.find_all(_exp.Join):
        if j.args.get("on") or j.args.get("using") or j.args.get("natural"):
            continue
        inner = j.this
        if isinstance(inner, (_exp.Unnest, _exp.Lateral)) or (inner is not None and inner.find(_exp.Unnest)):
            continue
        add("cross_join"); mark(inner if inner is not None else j, "cross_join")
    # 6) LIKE con comodín al inicio ('%...') → no aprovecha nada
    for like in tree.find_all(_exp.Like):
        pat = like.expression
        if isinstance(pat, _exp.Literal) and pat.args.get("is_string") and str(pat.this).startswith("%"):
            add("like_comodin"); mark(like, "like_comodin")
    # 7) UNION (deduplica) en vez de UNION ALL
    for u in tree.find_all(_exp.Union):
        if u.args.get("distinct"):
            add("union_dedup"); mark(u, "union_dedup")
    # 8) Tabla particionada sin filtro EFECTIVO por su columna de partición (vía
    #    catálogo cacheado). Una función sobre la partición rompe el pruning → no cuenta.
    sel2 = tree.find(_exp.Select)
    where = sel2.args.get("where") if sel2 is not None else None
    if get_partcols is not None and sel2 is not None and sel2.find(_exp.From):
        where_cols: set[str] = set()
        if where is not None:
            # Una partición filtra de verdad solo si la columna es operando DIRECTO de
            # una comparación. Si está envuelta en una función (cast/date/…) rompe el
            # pruning → no cuenta. (Ojo: en sqlglot `And` es subclase de Func, por eso
            # se valida el padre directo contra los predicados, no "algún ancestro Func".)
            preds = (_exp.EQ, _exp.NEQ, _exp.GT, _exp.GTE, _exp.LT, _exp.LTE, _exp.In, _exp.Between, _exp.Is)
            for col in where.find_all(_exp.Column):
                if isinstance(col.parent, preds):
                    where_cols.add((col.name or "").lower())
        for t in tree.find_all(_exp.Table):
            if not t.db or (t.name or "").lower() in ctes:
                continue
            try:
                parts = get_partcols(t.db, t.name)
            except Exception:
                parts = None
            if parts and not ({str(p).lower() for p in parts} & where_cols):
                add("sin_particion"); mark(t.this if t.this is not None else t, "sin_particion")
                break
    # 9) Función o CAST envolviendo una columna en un predicado del WHERE →
    #    el motor evalúa la función/cast fila por fila en vez de comparar el
    #    valor crudo, lo que rompe partition/predicate pruning aunque la
    #    columna sí esté filtrada. Se marca aunque no sea columna de partición.
    if where is not None:
        preds2 = (_exp.EQ, _exp.NEQ, _exp.GT, _exp.GTE, _exp.LT, _exp.LTE, _exp.Like, _exp.In, _exp.Between, _exp.Is)
        for pred in where.find_all(preds2):
            for side in (pred.this, pred.args.get("expression")):
                if side is None or isinstance(side, (_exp.Column, _exp.Literal)):
                    continue
                if isinstance(side, _exp.Cast) and side.find(_exp.Column):
                    add("cast_en_filtro"); mark(side, "cast_en_filtro")
                elif isinstance(side, _exp.Func) and side.find(_exp.Column):
                    add("func_en_filtro"); mark(side, "func_en_filtro")
    # 10) CTE referenciada más de una vez, o subconsulta con el mismo texto
    #     repetida → Athena/Presto no materializa CTEs por defecto: cada
    #     referencia recalcula la subconsulta completa (doble/triple escaneo).
    cte_names = [c.alias_or_name.lower() for c in tree.find_all(_exp.CTE) if c.alias_or_name]
    if cte_names:
        refs: dict[str, list[Any]] = {}
        for t in tree.find_all(_exp.Table):
            nm = (t.name or "").lower()
            if nm in cte_names:
                refs.setdefault(nm, []).append(t)
        for occ in refs.values():
            if len(occ) >= 2:
                add("subquery_repetida")
                for o in occ:
                    mark(o.this if o.this is not None else o, "subquery_repetida")
                break
    if "subquery_repetida" not in seen:
        seen_fp: dict[str, Any] = {}
        for sub in tree.find_all(_exp.Subquery):
            inner = sub.this
            if inner is None:
                continue
            try:
                fp = inner.sql(dialect="athena")
            except Exception:
                continue
            if fp in seen_fp:
                add("subquery_repetida")
                mark(seen_fp[fp], "subquery_repetida"); mark(sub, "subquery_repetida")
                break
            seen_fp[fp] = sub
    # 11) Tabla en formato no columnar (CSV/JSON/TEXT) → Athena lee y parsea
    #     la fila completa aunque pidas pocas columnas (vía catálogo cacheado).
    if get_format is not None:
        for t in tree.find_all(_exp.Table):
            if not t.db or (t.name or "").lower() in ctes:
                continue
            try:
                fmt = get_format(t.db, t.name)
            except Exception:
                fmt = ""
            if fmt and fmt not in ("parquet", "orc", "avro", "iceberg"):
                add("formato_no_columnar"); mark(t.this if t.this is not None else t, "formato_no_columnar")
                break

    uniq = sorted({(a, b) for a, b in marks})
    by_code = {c: [[a, b] for a, b in sorted({(x, y) for x, y in v})] for c, v in marks_by_code.items()}
    return {"issues": issues, "marks": [[a, b] for a, b in uniq], "marksByCode": by_code}


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
