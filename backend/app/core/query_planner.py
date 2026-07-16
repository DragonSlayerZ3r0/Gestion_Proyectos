"""Planificador de consultas — GENÉRICO y reutilizable (core, cero acoplamiento).

Convierte una consulta en lenguaje natural en dos partes:
  - **filtros estructurados** (atributos exactos: responsable, estado, base, tipo…)
  - **consulta semántica** (el tema/concepto a buscar por significado)

Por qué existe: la búsqueda semántica pura NO sabe filtrar por atributos exactos
("solicitudes donde el responsable sea Diego" devolvía casi todo). El planificador
separa lo exacto de lo conceptual, como el del Reporte ejecutivo, pero **generalizado**:
el "cerebro" (prompt + parseo) es compartido; cada módulo solo declara SUS campos
filtrables (que son, por definición, específicos de su dominio).

Sin imports del proyecto: el LLM se inyecta como un callable `complete(prompt, system)
-> str`. Así se copia tal cual a plataformas hermanas.
"""
import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

# Callable que completa un prompt con un LLM y devuelve el texto.
CompleteFn = Callable[[str, str], str]


@dataclass
class FilterField:
    """Un campo por el que un módulo permite filtrar. `values` (opcional) enumera
    los valores válidos como {id, label}: el planificador devuelve el `id`. Sin
    `values`, el campo es texto libre y el planificador devuelve la cadena tal cual."""
    key: str
    label: str
    description: str = ""
    values: Optional[list[dict[str, str]]] = None


@dataclass
class QueryPlan:
    filters: dict[str, str]     # {campo: id/valor} — solo lo que la consulta menciona
    semantic: str               # concepto a buscar por significado ("" si es puro filtro)
    interpretation: str         # frase legible de lo entendido (para mostrar al usuario)


PLANNER_SYSTEM = (
    "Eres un planificador de búsqueda. Conviertes una consulta en lenguaje natural en "
    "un filtro estructurado + una consulta semántica. Respondes con UN objeto JSON y "
    "nada más (sin explicación, sin ```). Estructura:\n"
    '{"filtros": {"<campo>": "<id o valor>"}, "semantica": "<tema a buscar por '
    'significado>", "interpretacion": "<frase corta en español de lo que entendiste>"}\n'
    "Reglas:\n"
    "- Usa SOLO los campos listados y, para los que traen valores, SOLO esos id "
    "(elige el que corresponda aunque la consulta lo diga parcial: «Diego» → el id de "
    "«Diego Sosa»). Si un valor no está en la lista, NO lo pongas.\n"
    "- `filtros` solo lleva lo que la consulta menciona CLARAMENTE como atributo "
    "(responsable, estado, área, tipo…). Vacío si no menciona ninguno.\n"
    "- `semantica` es el tema/concepto restante a buscar por significado, SIN la parte "
    "ya cubierta por filtros. Si la consulta es puramente un filtro (p. ej. «solicitudes "
    "del responsable Diego»), deja semantica = \"\".\n"
    "- `interpretacion`: qué entendiste, breve (p. ej. «responsable Diego Sosa» o "
    "«tema: cartera vencida, estado activo»).\n"
    "- No inventes campos ni valores fuera de los dados.")


def plan_query(query: str, fields: list[FilterField], complete_fn: CompleteFn) -> QueryPlan:
    """Planifica la consulta. Best-effort: ante cualquier fallo (LLM caído, JSON
    inválido) degrada a "todo semántico" (filtros vacíos, semantic = la consulta),
    que reproduce el comportamiento de búsqueda semántica pura."""
    query = (query or "").strip()
    if not query:
        return QueryPlan({}, "", "")

    lines: list[str] = []
    valid: dict[str, Optional[set[str]]] = {}
    for f in fields:
        if f.values:
            vals = "; ".join(f'{v["id"]}={v["label"]}' for v in f.values[:80])
            lines.append(f"- {f.key} ({f.label}): {f.description}. Valores: {vals}")
            valid[f.key] = {v["id"] for v in f.values}
        else:
            lines.append(f"- {f.key} ({f.label}): {f.description}. (texto libre)")
            valid[f.key] = None

    prompt = ("CAMPOS FILTRABLES (usa solo estos):\n" + "\n".join(lines)
              + f"\n\nCONSULTA: {query}\n\nDevuelve el JSON del plan.")
    try:
        text = complete_fn(prompt, PLANNER_SYSTEM)
    except Exception:                       # noqa: BLE001 — degradar, no romper
        return QueryPlan({}, query, "")
    plan = _parse(text, valid)
    return plan or QueryPlan({}, query, "")


def _parse(text: str, valid: dict[str, Optional[set[str]]]) -> Optional[QueryPlan]:
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        return None
    try:
        raw = json.loads(m.group(0))
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    filters: dict[str, str] = {}
    raw_filters = raw.get("filtros")
    if isinstance(raw_filters, dict):
        for k, v in raw_filters.items():
            if k not in valid:
                continue                    # campo no declarado → descartar
            val = str(v).strip()
            if not val:
                continue
            allowed = valid[k]
            if allowed is not None and val not in allowed:
                continue                    # id inválido (no está en los valores) → descartar
            filters[k] = val
    semantic = str(raw.get("semantica") or "").strip()
    interpretation = str(raw.get("interpretacion") or "").strip()[:200]
    return QueryPlan(filters, semantic, interpretation)
