"""Contexto de catálogo para un SQL: qué tablas referencia y, por cada una, su
formato físico, columnas de partición y columnas con tipo — todo desde el catálogo
cacheado en DynamoDB (nunca toca Glue). Las tablas que aparecen SIN base se
resuelven buscándolas por nombre en todas las bases cacheadas.

Compartido por la Sugerencia IA de Athena (`AthenaMonitorService.suggest_fix`) y
por el chat de apoyo técnico (que enriquece el prompt cuando el usuario pega un
query) — misma "receta" de contexto, así el chat sugiere con la misma calidad.
"""

import os
import re
import sys
from typing import Any

from repositories.catalog import CatalogRepository

_VENDOR = os.path.join(os.path.dirname(__file__), "..", "_vendor")
if _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)
try:
    import sqlglot
    from sqlglot import exp as _exp
except Exception:      # pragma: no cover - sin el vendor, el contexto queda vacío
    sqlglot = None
    _exp = None

_MAX_COLS = 60   # tope de columnas por tabla, para no inflar el prompt
# Bloques de código cercados (``` o ```sql) dentro de un mensaje de chat.
_FENCE_RE = re.compile(r"```[a-zA-Z]*\s*\n(.*?)```", re.S)
# Gate barato para intentar parsear texto suelto como SQL (sin cercas).
_SQLISH_RE = re.compile(r"\b(select|insert|create|with|update|delete|merge)\b", re.I)


class SqlCatalogContext:
    """Acumula las tablas de uno o más SQL y arma el bloque de contexto que se le
    da al modelo. Memoiza las lecturas del catálogo por (base, tabla)."""

    def __init__(self, repository: CatalogRepository | None = None) -> None:
        self._cat = repository or CatalogRepository()
        self._meta: dict[tuple[str, str], dict[str, Any]] = {}
        self._db_names: list[str] | None = None
        self._notes: list[str] = []
        self._seen_unqualified: set[str] = set()

    # ── Lecturas memoizadas (también sirven de callbacks para _lint_sql) ────────
    def table_meta(self, db: str, table: str) -> dict[str, Any]:
        key = (db, table)
        if key not in self._meta:
            try:
                self._meta[key] = self._cat.get_catalog_table(db, table) or {}
            except Exception:
                self._meta[key] = {}
        return self._meta[key]

    def get_partcols(self, db: str, table: str) -> Any:
        return self.table_meta(db, table).get("partitionKeys") or None

    def get_format(self, db: str, table: str) -> str:
        return self.table_meta(db, table).get("format") or ""

    # ── Registro de tablas desde SQL ────────────────────────────────────────────
    def add_sql(self, sql: str) -> bool:
        """Registra las tablas del SQL (excluye CTEs). Las calificadas se leen del
        catálogo directo; las SIN base se resuelven contra todas las bases cacheadas
        y se anota el resultado. Devuelve True si parseó y tenía al menos una tabla
        real. Nunca lanza."""
        if not sql or sqlglot is None:
            return False
        try:
            trees = sqlglot.parse(sql, read="athena")
        except Exception:
            return False
        found = False
        for tree in trees:
            if tree is None:
                continue
            ctes = {c.alias_or_name.lower() for c in tree.find_all(_exp.CTE)}
            for t in tree.find_all(_exp.Table):
                name = t.name or ""
                if not name or name.lower() in ctes:
                    continue
                found = True
                if t.db:
                    self.table_meta(t.db, name)
                    continue
                if name.lower() in self._seen_unqualified:
                    continue
                self._seen_unqualified.add(name.lower())
                if self._db_names is None:
                    try:
                        self._db_names = [d.get("database") for d in self._cat.list_catalog_databases()
                                          if d.get("database")]
                    except Exception:
                        self._db_names = []
                matches = [db for db in self._db_names if self.table_meta(db, name)]
                if len(matches) == 1:
                    self._notes.append(
                        f"- `{name}` aparece SIN base en el query; según el catálogo vive en "
                        f"`{matches[0]}` → califícala como `{matches[0]}.{name}`.")
                elif len(matches) > 1:
                    self._notes.append(
                        f"- `{name}` aparece SIN base y existe en varias bases del catálogo "
                        f"({', '.join(matches)}); indica que el usuario debe confirmar cuál usar.")
        return found

    # ── Bloques de texto para el prompt ─────────────────────────────────────────
    @property
    def notes(self) -> list[str]:
        return self._notes

    def catalog_block(self) -> str:
        """Una línea por tabla con formato/particiones + sus columnas con tipo."""
        lines: list[str] = []
        for (db, table), meta in self._meta.items():
            if not meta:
                continue
            parts = meta.get("partitionKeys") or []
            fmt = meta.get("format") or "desconocido"
            lines.append(f"- {db}.{table}: formato={fmt}, particiones={', '.join(parts) or 'ninguna'}")
            cols = meta.get("columns") or []
            if cols:
                col_txt = ", ".join(f"{c.get('name')}:{c.get('type')}" for c in cols[:_MAX_COLS] if c.get("name"))
                if len(cols) > _MAX_COLS:
                    col_txt += f", … ({len(cols) - _MAX_COLS} columnas más)"
                lines.append(f"  columnas: {col_txt}")
        return "\n".join(lines)

    def context_block(self) -> str:
        """Bloque combinado (catálogo + resolución de tablas sin base) listo para
        anexar a un prompt. Vacío si ninguna tabla se encontró en el catálogo."""
        cat = self.catalog_block()
        if not cat and not self._notes:
            return ""
        out = "Catálogo de las tablas referenciadas:\n" + (cat or "(sin datos de catálogo disponibles)")
        if self._notes:
            out += "\n\nTablas resueltas contra el catálogo:\n" + "\n".join(self._notes)
        return out


def extract_sql_candidates(text: str) -> list[str]:
    """Candidatos a SQL dentro de un mensaje de chat: los bloques de código
    cercados (```sql … ```); si no hay cercas pero el texto "parece SQL",
    el texto completo. Lista vacía si nada aplica."""
    candidates = _FENCE_RE.findall(text or "")
    if not candidates and _SQLISH_RE.search(text or ""):
        candidates = [text]
    return candidates


def context_for_chat_texts(texts: list[str], repository: CatalogRepository | None = None) -> str:
    """Contexto de catálogo para mensajes de chat. Devuelve el bloque combinado
    o '' si ningún texto traía SQL con tablas del catálogo."""
    ctx = SqlCatalogContext(repository)
    found = False
    for text in texts or []:
        for cand in extract_sql_candidates(text):
            found = ctx.add_sql(cand) or found
    return ctx.context_block() if found else ""
