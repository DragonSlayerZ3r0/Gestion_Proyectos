"""Reporte ejecutivo de solicitudes: el usuario pide en lenguaje natural (o con un
preajuste) y un LLM redacta el reporte + la especificación de UN diagrama que el
frontend dibuja con plantillas propias (el modelo NUNCA dibuja: decide contenido).

Asíncrono (self-invoke, patrón del chat): el razonador puede tardar más que los
30 s de API Gateway, así que el POST encola y el frontend sondea por reportId.

BÚSQUEDA DE DOS PASOS (para escalar a miles de solicitudes sin volcar todo al
modelo, ver docs/22 2026-07-15):
  1. PLANIFICADOR (LLM barato, sin datos): la pregunta → un filtro estructurado
     (conceptos + sinónimos, palabras clave, personas, estados, agregados).
  2. BÚSQUEDA HÍBRIDA (código): filtros estructurados + semántica (embeddings
     Titan) + literal; puntúa cada solicitud por relevancia y arma el contexto
     con las más relevantes hasta un presupuesto (recorte elegante, avisando
     cuántas quedaron fuera). Preguntas amplias → ranking por actividad reciente
     + agregados.
  3. REDACTOR (LLM): escribe el reporte SOLO sobre ese subconjunto.
Todo con fallback: si el planificador o los embeddings fallan, cae al portafolio
activo por recencia — el reporte nunca se rompe."""
import json
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import boto3

from core.errors import ValidationError
from repositories.exec_report import ExecReportRepository
from services.llm import LlmService
from services.workspace import WorkspaceService

MAX_PROMPT_CHARS = 500
# Presupuesto de caracteres del contexto que viaja al redactor. Cota real de
# escala: sin importar cuántas solicitudes haya, solo entran las más relevantes
# hasta aquí (el resto se resume como conteo). Deja aire para prompt + system
# dentro del tope de 60000 de la llamada.
_CONTEXT_BUDGET_CHARS = 45000
_MAX_UPDATES_PER_PROJECT = 12       # tope por solicitud para que una no acapare
_UPDATE_SNIPPET_CHARS = 400

# Preajustes de junta (el frontend los muestra como botones de un clic).
PRESETS = {
    "criticos": "Temas críticos: qué tenemos hoy, en qué estado está cada uno y cuándo se entrega.",
    "detenidos": "Qué solicitudes están detenidas o sin avance, hace cuánto, y qué las detiene según los seguimientos.",
    "avance": "Avance general del portafolio de solicitudes, destacando las más rezagadas respecto a su fecha de entrega.",
    "hitos": "Línea de tiempo de los hitos y entregas próximas de las solicitudes activas.",
}

PLANNER_SYSTEM = (
    "Eres un planificador de búsqueda sobre un portafolio de solicitudes internas. "
    "NO redactas el reporte: solo decides QUÉ buscar. Respondes con UN objeto JSON "
    "y nada más (sin explicación, sin ```). Claves:\n"
    '{"semantica": ["concepto a buscar", ...], "palabrasClave": ["término literal", ...], '
    '"personas": ["nombre", ...], "estados": ["clave-estado", ...], '
    '"soloActivas": true, "agregados": false}\n'
    "Guía:\n"
    "- semantica: temas/conceptos del pedido; INCLUYE sinónimos y variantes (p. ej. "
    "'fraude' → ['prevención de fraude','AML','lavado de dinero','monitoreo transaccional']). Vacío si no hay tema.\n"
    "- palabrasClave: términos exactos que deban aparecer literalmente (nombres de sistema, siglas).\n"
    "- personas: nombres de personas mencionadas (responsable o quien hizo algo). Vacío si no aplica.\n"
    "- estados: filtra por estado; usa SOLO las claves de la lista de ESTADOS que se te da. Vacío = todos.\n"
    "- soloActivas: false si piden histórico, cerradas, entregadas o 'de todo el tiempo'.\n"
    "- agregados: true si piden conteos, tendencias, panorama general o 'cómo vamos'.\n"
    "Pregunta amplia ('panorama', 'cómo vamos', 'qué hay pendiente') → deja semantica/"
    "palabrasClave/personas vacíos, soloActivas=true, agregados=true. No inventes nombres "
    "ni estados fuera de las listas dadas.")

SYSTEM_PROMPT = (
    "Eres un analista que prepara reportes para junta directiva sobre un portafolio "
    "de solicitudes internas. Respondes SIEMPRE en español profesional y directo. "
    "Te basas SOLO en los datos que te entregan — nunca inventes solicitudes, fechas "
    "ni responsables; si un dato falta (p. ej. sin fecha de entrega), dilo. "
    "Estructura: un reporte en markdown breve y accionable (títulos, viñetas o tabla "
    "cuando aporte), pensado para leerse en 1 minuto. Al FINAL, si el pedido se "
    "presta a un diagrama, agrega UN bloque ```json con la especificación:\n"
    '{"type": "rag", "title": "...", "items": [{"name": "...", "level": "verde|ambar|rojo", "note": "...", "dueDate": "YYYY-MM-DD"}]}\n'
    '{"type": "progress", "title": "...", "items": [{"name": "...", "progress": 0-100, "dueDate": "YYYY-MM-DD"}]}\n'
    '{"type": "timeline", "title": "...", "items": [{"date": "YYYY-MM-DD", "label": "...", "kind": "hito|entrega|alerta"}]}\n'
    "Elige el tipo que mejor responda al pedido (semáforo=estado/riesgo, "
    "progress=avance, timeline=fechas/hitos). Máximo 12 items, name ≤ 40 caracteres, "
    "note/label ≤ 80. Si ningún diagrama aplica, omite el bloque json. No menciones "
    "el bloque json en el texto del reporte.")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm(text: str) -> str:
    """Minúsculas + sin acentos, para casar texto libre (personas, palabras clave)
    sin fallar por tildes o mayúsculas."""
    s = unicodedata.normalize("NFD", str(text or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def _last_activity(project: dict[str, Any]) -> str:
    """Fecha de la última señal de vida (seguimiento más reciente o fecha de
    entrega o solicitud): ordena preguntas amplias por lo más movido primero."""
    updates = project.get("updates") or []
    dates = [u.get("date", "") for u in updates if u.get("date")]
    dates += [project.get("dueDate") or "", project.get("requestDate") or "",
              project.get("updatedAt") or ""]
    return max((d for d in dates if d), default="")


class ExecReportService:
    def __init__(self, repository: ExecReportRepository | None = None) -> None:
        self._db = repository or ExecReportRepository()

    # ── API ───────────────────────────────────────────────────────────────────
    def start(self, user_id: str, kind: str, text: str, function_name: str) -> dict[str, Any]:
        prompt = PRESETS.get(kind) or (text or "").strip()
        if not prompt:
            raise ValidationError("Indica qué reporte necesitas (elige un preajuste o escríbelo).")
        if len(prompt) > MAX_PROMPT_CHARS:
            raise ValidationError(f"El pedido supera el máximo de {MAX_PROMPT_CHARS} caracteres.")
        report_id = uuid4().hex
        self._db.put_report(user_id, report_id, prompt, "generating", _now())
        boto3.client("lambda").invoke(
            FunctionName=function_name, InvocationType="Event",
            Payload=json.dumps({"action": "workspace_report", "userId": user_id,
                                "reportId": report_id}).encode())
        return {"reportId": report_id, "pending": True}

    def get(self, user_id: str, report_id: str) -> dict[str, Any]:
        item = self._db.get_report(user_id, report_id)
        if not item:
            raise ValidationError("El reporte no existe (pudo haber expirado).")
        return {
            "reportId": report_id, "status": item.get("status", "generating"),
            "report": item.get("report", ""), "diagram": item.get("diagram"),
            "prompt": item.get("prompt", ""), "generatedAt": item.get("generatedAt", ""),
        }

    # ── Worker (self-invoke) ──────────────────────────────────────────────────
    def run(self, user_id: str, report_id: str) -> None:
        item = self._db.get_report(user_id, report_id)
        if not item:
            return
        try:
            prompt = item.get("prompt", "")
            ws = WorkspaceService().get_workspace()
            plan = self._plan(prompt, ws)                 # paso 1
            context = self._build_context(ws, plan)       # paso 2
            result = LlmService().converse(               # paso 3
                [{"role": "user", "text": f"{context}\n\nPEDIDO DEL USUARIO: {prompt}"}],
                system=SYSTEM_PROMPT, max_tokens=2200, max_prompt_chars=60000)
            report_md, diagram = self._split_diagram(result["text"])
            if result.get("stopReason") == "max_tokens":
                report_md += "\n\n*(El reporte se cortó por longitud; pide una versión más acotada.)*"
            self._db.finish_report(user_id, report_id, report_md, diagram, _now())
        except Exception:
            self._db.finish_report(
                user_id, report_id,
                "No fue posible generar el reporte esta vez. Vuelve a intentarlo.",
                None, _now(), status="error")
            raise

    # ── Paso 1: planificador (LLM barato) → filtro estructurado ──────────────
    def _plan(self, prompt: str, ws: dict[str, Any]) -> dict[str, Any]:
        """La pregunta + catálogos → JSON de búsqueda. Best-effort: cualquier
        fallo (LLM caído, JSON inválido) cae a un plan amplio (activas + agregados),
        que reproduce el comportamiento anterior (ver todo lo vivo)."""
        default = {"semantica": [], "palabrasClave": [], "personas": [],
                   "estados": [], "soloActivas": True, "agregados": True}
        try:
            statuses = [f'{s["id"]}={s["label"]}' for s in ws.get("projectStatuses", [])
                        if isinstance(s, dict)]
            people = [p["fullName"] for p in ws.get("people", []) if p.get("fullName")]
            catalog = (f"ESTADOS (clave=etiqueta): {', '.join(statuses) or '(ninguno)'}\n"
                       f"PERSONAS: {', '.join(people[:60]) or '(ninguna)'}")
            out = LlmService().complete(
                f"{catalog}\n\nPREGUNTA: {prompt}\n\nDevuelve el JSON del plan.",
                system=PLANNER_SYSTEM, max_tokens=500, thinking=False)
            plan = self._parse_plan(out.get("text", ""))
            return plan or default
        except Exception:
            return default

    def _parse_plan(self, text: str) -> dict[str, Any] | None:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return None
        try:
            raw = json.loads(m.group(0))
        except ValueError:
            return None
        if not isinstance(raw, dict):
            return None
        def _strlist(v: Any) -> list[str]:
            return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []
        return {
            "semantica": _strlist(raw.get("semantica"))[:6],
            "palabrasClave": _strlist(raw.get("palabrasClave"))[:10],
            "personas": _strlist(raw.get("personas"))[:10],
            "estados": _strlist(raw.get("estados"))[:10],
            "soloActivas": bool(raw.get("soloActivas", True)),
            "agregados": bool(raw.get("agregados", False)),
        }

    # ── Paso 2: búsqueda híbrida → contexto acotado ──────────────────────────
    _ACTIVE_EXCLUDE = {"done", "delivered", "cancelled", "canceled", "entregado",
                       "entregada", "cerrado", "cerrada", "cancelado", "cancelada",
                       "completado", "completada", "finalizado", "finalizada"}

    def _build_context(self, ws: dict[str, Any], plan: dict[str, Any]) -> str:
        projects = ws.get("projects", [])
        areas = {a["id"]: a["name"] for a in ws.get("areas", [])}
        statuses = {s["id"]: s["label"] for s in ws.get("projectStatuses", []) if isinstance(s, dict)}
        people = {p["id"]: p["fullName"] for p in ws.get("people", [])}
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        # Señales del plan
        semantic_scores = self._semantic_scores(plan.get("semantica", []))
        keywords = [_norm(k) for k in plan.get("palabrasClave", [])]
        personas = [_norm(p) for p in plan.get("personas", [])]
        estado_filter = set(plan.get("estados") or [])
        has_signal = bool(semantic_scores or keywords or personas or estado_filter)

        # Puntúa cada solicitud por relevancia al pedido
        scored: list[tuple[float, dict[str, Any]]] = []
        for p in projects:
            if estado_filter and p.get("status") not in estado_filter:
                continue
            score = self._score_project(p, semantic_scores, keywords, personas, people)
            if has_signal and score <= 0:
                continue                    # con señal, solo lo que casa
            scored.append((score, p))

        # Sin señal (pregunta amplia) o sin coincidencias → ranking por recencia
        if not scored:
            scored = [(0.0, p) for p in projects]
        scored.sort(key=lambda sp: (sp[0], _last_activity(sp[1])), reverse=True)

        # soloActivas: preferir activas arriba, pero NO excluir del todo (permite
        # "qué se entregó" si el modelo lo pide); las cerradas caen al final.
        if plan.get("soloActivas", True) and not estado_filter:
            scored.sort(key=lambda sp: (
                sp[0], 0 if _norm(statuses.get(sp[1].get("status"), sp[1].get("status") or "")) in self._ACTIVE_EXCLUDE else 1,
                _last_activity(sp[1])), reverse=True)

        # Arma el contexto hasta el presupuesto (recorte elegante)
        header = [f"FECHA DE HOY: {today}"]
        if plan.get("agregados"):
            header.append(self._aggregates_block(projects, areas, statuses))
        header.append("SOLICITUDES RELEVANTES (de mayor a menor relación con el pedido):")
        lines = list(header)
        used = sum(len(x) for x in lines)
        included = 0
        for _score, p in scored:
            block = self._project_block(p, areas, statuses, people)
            if included > 0 and used + len(block) > _CONTEXT_BUDGET_CHARS:
                break
            lines.append(block)
            used += len(block)
            included += 1
        omitted = len(scored) - included
        if omitted > 0:
            lines.append(
                f"\n(NOTA DE ALCANCE: se incluyeron las {included} solicitudes más "
                f"relevantes de {len(scored)} candidatas; {omitted} quedaron fuera por "
                f"longitud. Si el usuario necesita las omitidas, pídele acotar el pedido.)")
        return "\n".join(lines)

    def _semantic_scores(self, queries: list[str]) -> dict[str, float]:
        """projectId → similitud acumulada de coincidencias semánticas (solicitud +
        seguimiento). Best-effort: si el índice falla, devuelve vacío y la búsqueda
        sigue con literal/estructurado."""
        scores: dict[str, float] = {}
        if not queries:
            return scores
        try:
            from services.embedding_index import seguimiento_index, solicitud_index
            sidx, uidx = solicitud_index(), seguimiento_index()
            for q in queries[:6]:
                for hit in sidx.search(q, top_k=20, min_score=0.25):
                    pid = (hit.get("meta") or {}).get("projectId") or hit.get("docId", "")
                    if pid:
                        scores[pid] = scores.get(pid, 0.0) + hit["score"]
                for hit in uidx.search(q, top_k=30, min_score=0.25):
                    pid = (hit.get("meta") or {}).get("projectId", "")
                    if pid:
                        scores[pid] = scores.get(pid, 0.0) + hit["score"] * 0.8
        except Exception:
            return scores
        return scores

    def _score_project(self, p: dict[str, Any], semantic: dict[str, float],
                       keywords: list[str], personas: list[str],
                       people: dict[str, str]) -> float:
        score = semantic.get(p.get("id", ""), 0.0)
        haystack = _norm(" ".join([
            p.get("name") or "", p.get("description") or "",
            people.get(p.get("ownerPersonId"), ""),
            " ".join((u.get("text") or "") for u in (p.get("updates") or [])),
            " ".join((u.get("createdByName") or "") for u in (p.get("updates") or [])),
        ]))
        for kw in keywords:
            if kw and kw in haystack:
                score += 1.0
        for name in personas:
            if name and name in haystack:
                score += 1.0
        return score

    def _project_block(self, p: dict[str, Any], areas: dict[str, str],
                       statuses: dict[str, str], people: dict[str, str]) -> str:
        tasks = p.get("tasks", [])
        done = sum(1 for t in tasks if t.get("status") == "done")
        parts = [
            f"- {p.get('name', '(sin nombre)')}",
            f"estado={statuses.get(p.get('status'), p.get('status') or 'sin estado')}",
            f"área={areas.get(p.get('requestingAreaId'), 'sin área')}",
            f"responsable={people.get(p.get('ownerPersonId'), 'sin responsable')}",
            f"solicitada={p.get('requestDate') or 'sin fecha'}",
            f"entrega={p.get('dueDate') or 'sin fecha'}",
            f"avance={'%s%%' % p['progress'] if p.get('progress') != '' else 'sin definir'}",
            f"tareas={done}/{len(tasks)} completadas",
        ]
        if p.get("description"):
            parts.append(f"descripción={str(p['description'])[:200]}")
        lines = [", ".join(parts)]
        updates = p.get("updates") or []
        for u in updates[:_MAX_UPDATES_PER_PROJECT]:
            txt = (u.get("text") or "").replace("\n", " ")[:_UPDATE_SNIPPET_CHARS]
            who = u.get("createdByName") or u.get("createdBy") or ""
            who_s = f" por {who}" if who else ""
            lines.append(f"    seguimiento {u.get('date')}{who_s}: {txt}")
        if len(updates) > _MAX_UPDATES_PER_PROJECT:
            lines.append(f"    (+{len(updates) - _MAX_UPDATES_PER_PROJECT} seguimientos más antiguos)")
        return "\n".join(lines)

    def _aggregates_block(self, projects: list[dict[str, Any]], areas: dict[str, str],
                          statuses: dict[str, str]) -> str:
        """Conteos precalculados (para preguntas amplias/tendencias): mucho panorama
        en pocos caracteres, sin volcar cada solicitud."""
        by_status: dict[str, int] = {}
        by_area: dict[str, int] = {}
        by_due_month: dict[str, int] = {}
        for p in projects:
            st = statuses.get(p.get("status"), p.get("status") or "sin estado")
            by_status[st] = by_status.get(st, 0) + 1
            ar = areas.get(p.get("requestingAreaId"), "sin área")
            by_area[ar] = by_area.get(ar, 0) + 1
            due = str(p.get("dueDate") or "")[:7]
            if re.match(r"^\d{4}-\d{2}$", due):
                by_due_month[due] = by_due_month.get(due, 0) + 1
        def _fmt(d: dict[str, int]) -> str:
            return ", ".join(f"{k}: {v}" for k, v in sorted(d.items(), key=lambda kv: kv[1], reverse=True))
        return ("PANORAMA (conteos sobre TODO el portafolio):\n"
                f"  total solicitudes: {len(projects)}\n"
                f"  por estado: {_fmt(by_status)}\n"
                f"  por área: {_fmt(by_area)}\n"
                f"  entregas por mes: {_fmt(by_due_month) or 'sin fechas de entrega'}")

    # ── Separar el bloque json del markdown y validarlo ───────────────────────
    _DIAGRAM_TYPES = {"rag", "progress", "timeline"}
    _RAG_LEVELS = {"verde", "ambar", "rojo"}
    _TL_KINDS = {"hito", "entrega", "alerta"}

    def _split_diagram(self, text: str) -> tuple[str, dict[str, Any] | None]:
        m = None
        for m in re.finditer(r"```json\s*([\s\S]*?)```", text):
            pass                      # el ÚLTIMO bloque json (el spec va al final)
        if not m:
            return text.strip(), None
        report_md = (text[:m.start()] + text[m.end():]).strip()
        try:
            spec = json.loads(m.group(1))
        except ValueError:
            return report_md, None
        diagram = self._validate_diagram(spec)
        return report_md, diagram

    def _clean_date(self, value: Any) -> str:
        """Solo fechas AAAA-MM-DD reales; null/None/"sin fecha" del modelo → ""."""
        s = str(value or "")[:10]
        return s if re.match(r"^\d{4}-\d{2}-\d{2}$", s) else ""

    def _validate_diagram(self, spec: Any) -> dict[str, Any] | None:
        """El spec del modelo se valida y recorta ANTES de guardarlo: el frontend
        dibuja lo que llegue aquí sin volver a validar. Basura → sin diagrama."""
        if not isinstance(spec, dict) or spec.get("type") not in self._DIAGRAM_TYPES:
            return None
        items = spec.get("items")
        if not isinstance(items, list) or not items:
            return None
        clean: list[dict[str, Any]] = []
        for it in items[:12]:
            if not isinstance(it, dict):
                continue
            if spec["type"] == "rag":
                if it.get("level") not in self._RAG_LEVELS:
                    continue
                clean.append({"name": str(it.get("name", ""))[:40], "level": it["level"],
                              "note": str(it.get("note", ""))[:80], "dueDate": self._clean_date(it.get("dueDate"))})
            elif spec["type"] == "progress":
                try:
                    prog = max(0, min(100, int(it.get("progress"))))
                except (TypeError, ValueError):
                    continue
                clean.append({"name": str(it.get("name", ""))[:40], "progress": prog,
                              "dueDate": self._clean_date(it.get("dueDate"))})
            else:   # timeline
                date = str(it.get("date", ""))[:10]
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
                    continue
                kind = it.get("kind") if it.get("kind") in self._TL_KINDS else "hito"
                clean.append({"date": date, "label": str(it.get("label", ""))[:80], "kind": kind})
        if not clean:
            return None
        return {"type": spec["type"], "title": str(spec.get("title", ""))[:80], "items": clean}
