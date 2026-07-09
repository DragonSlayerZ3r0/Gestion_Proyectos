"""Reporte ejecutivo de solicitudes: el usuario pide en lenguaje natural (o con un
preajuste) y un LLM redacta el reporte + la especificación de UN diagrama que el
frontend dibuja con plantillas propias (el modelo NUNCA dibuja: decide contenido).

Asíncrono (self-invoke, patrón del chat): el razonador puede tardar más que los
30 s de API Gateway, así que el POST encola y el frontend sondea por reportId."""
import json
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import boto3

from core.errors import ValidationError
from repositories.exec_report import ExecReportRepository
from services.llm import LlmService
from services.workspace import WorkspaceService

MAX_PROMPT_CHARS = 500
_MAX_UPDATES_PER_PROJECT = 3
_UPDATE_SNIPPET_CHARS = 220

# Preajustes de junta (el frontend los muestra como botones de un clic).
PRESETS = {
    "criticos": "Temas críticos: qué tenemos hoy, en qué estado está cada uno y cuándo se entrega.",
    "detenidos": "Qué solicitudes están detenidas o sin avance, hace cuánto, y qué las detiene según los seguimientos.",
    "avance": "Avance general del portafolio de solicitudes, destacando las más rezagadas respecto a su fecha de entrega.",
    "hitos": "Línea de tiempo de los hitos y entregas próximas de las solicitudes activas.",
}

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
            context = self._build_context()
            result = LlmService().converse(
                [{"role": "user", "text": f"{context}\n\nPEDIDO DEL USUARIO: {item.get('prompt', '')}"}],
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

    # ── Contexto (desde los mismos datos del módulo Solicitudes) ─────────────
    def _build_context(self) -> str:
        ws = WorkspaceService().get_workspace()
        areas = {a["id"]: a["name"] for a in ws.get("areas", [])}
        statuses = {s["id"]: s["label"] for s in ws.get("projectStatuses", []) if isinstance(s, dict)}
        people = {p["id"]: p["fullName"] for p in ws.get("people", [])}
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        lines = [f"FECHA DE HOY: {today}", "PORTAFOLIO DE SOLICITUDES:"]
        for p in ws.get("projects", []):
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
            lines.append(", ".join(parts))
            for u in (p.get("updates") or [])[:_MAX_UPDATES_PER_PROJECT]:
                txt = (u.get("text") or "").replace("\n", " ")[:_UPDATE_SNIPPET_CHARS]
                lines.append(f"    seguimiento {u.get('date')}: {txt}")
        return "\n".join(lines)

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
