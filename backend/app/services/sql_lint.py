"""Detector de antipatrones SQL para Athena (AST con sqlglot, no regex).

`lint_sql` devuelve por consulta los hallazgos (code+label) y los tramos de
caracteres a resaltar, tanto unificados (`marks`) como por antipatrón
(`marksByCode`). Los callbacks opcionales `get_partcols`/`get_format` conectan
las reglas de partición y formato con el catálogo cacheado (ver
`services/sql_context.SqlCatalogContext`, cuyos métodos encajan directo).

Usado por el monitoreo de Athena (escaneo + Sugerencia IA) y por el chat de
apoyo técnico (detección inmediata al pegar un query).
"""

import os
import sys
from typing import Any

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


# Antipatrones de SQL que encarecen/lentifican Athena. code -> etiqueta (badge).
ANTIPATTERNS = {
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


def lint_sql(sql: str, get_partcols: Any = None, get_format: Any = None) -> dict[str, Any]:
    """Detecta antipatrones en el SQL por AST (sqlglot, dialecto athena).
    Devuelve {issues:[{code,label}], marks:[[start,end],...]} con rangos de
    caracteres (inclusivos) sobre `sql` para resaltar lo problemático en rojo.
    `get_partcols(db, table) -> list[str]|None` permite marcar "sin filtro de
    partición" y `get_format(db, table) -> str` "formato no columnar", ambos
    usando el catálogo cacheado (sin tocar Glue). Nunca lanza: si el vendor
    falta o el SQL no parsea, degrada con elegancia."""
    if not sql or sqlglot is None:
        return {"issues": [], "marks": [], "marksByCode": {}, "tables": []}
    issues: list[dict[str, str]] = []
    marks: list[list[int]] = []
    marks_by_code: dict[str, list[list[int]]] = {}
    seen: set[str] = set()

    def add(code: str) -> None:
        if code not in seen:
            seen.add(code)
            issues.append({"code": code, "label": ANTIPATTERNS.get(code, code)})

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
        return {"issues": [{"code": "no_parse", "label": ANTIPATTERNS["no_parse"]}], "marks": [], "marksByCode": {}, "tables": []}

    ctes = {c.alias_or_name.lower() for c in tree.find_all(_exp.CTE)}
    # 1) SELECT * en la proyección (no confundir con count(*))
    for star in tree.find_all(_exp.Star):
        p = star.parent
        if isinstance(p, _exp.Select) or (isinstance(p, _exp.Column) and isinstance(p.parent, _exp.Select)):
            add("select_star"); mark(star, "select_star")
    # 2) tabla referenciada sin base de datos (excluye CTEs y subconsultas).
    #    La posición vive en el identificador (t.this), no en el nodo Table.
    #    De paso se recolectan las tablas CALIFICADAS (db.tabla) — las usa el
    #    índice de uso por tabla del Catálogo, sin re-parsear el SQL.
    qualified_tables: set[tuple[str, str]] = set()
    for t in tree.find_all(_exp.Table):
        if not t.name or t.name.lower() in ctes:
            continue
        if t.db:
            qualified_tables.add((t.db.lower(), t.name.lower()))
        else:
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
    return {"issues": issues, "marks": [[a, b] for a, b in uniq], "marksByCode": by_code,
            "tables": sorted(qualified_tables)}
