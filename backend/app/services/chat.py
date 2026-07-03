import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import boto3

from core.errors import ValidationError
from repositories.chat import ChatRepository
from services.llm import LlmService
from services.sql_context import SqlCatalogContext, context_for_chat_texts, extract_sql_candidates
from services.sql_lint import lint_sql


def _detect_antipatterns(text: str) -> list[str]:
    """Corre el MISMO detector determinístico del monitoreo (`lint_sql`) sobre el
    SQL que venga en un mensaje de chat. Devuelve las etiquetas detectadas (sin
    `no_parse`: en chat el texto suelto que no parsea es ruido, no un hallazgo).
    Es rápido (ms) → se puede correr en el POST y mostrarse al usuario de
    inmediato, mientras el modelo genera la respuesta completa."""
    ctx = SqlCatalogContext()
    labels: list[str] = []
    seen: set[str] = set()
    for cand in extract_sql_candidates(text):
        try:
            res = lint_sql(cand, ctx.get_partcols, ctx.get_format)
        except Exception:
            continue
        for issue in res.get("issues", []):
            if issue["code"] != "no_parse" and issue["code"] not in seen:
                seen.add(issue["code"])
                labels.append(issue["label"])
    return labels

MAX_TEXT_CHARS = 4000
MAX_HISTORY_MESSAGES = 20   # últimos N turnos que se reenvían al modelo (costo/latencia)
MESSAGE_TTL_DAYS = 60
TITLE_MAX_CHARS = 60

SYSTEM_PROMPT = (
    "Eres el asistente de apoyo técnico interno de la plataforma Gestión de "
    "Proyectos (gestión de proyectos/tareas, catálogo de datos, monitoreo de "
    "Athena). Respondes en español claro y directo. Ayudas con dudas técnicas "
    "generales (SQL, AWS, buenas prácticas) y, cuando el usuario pregunte cómo "
    "mejorar un query, das sugerencias concretas. Si falta contexto para "
    "responder bien (qué tabla, qué objetivo busca, qué motor/lenguaje), "
    "pregúntalo en vez de adivinar. Sé breve salvo que el usuario pida detalle.")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ChatService:
    def __init__(self, repository: ChatRepository | None = None) -> None:
        self._db = repository or ChatRepository()

    def list_sessions(self, user_id: str) -> list[dict[str, Any]]:
        sessions = self._db.list_sessions(user_id)
        sessions.sort(key=lambda s: s.get("updatedAt", ""), reverse=True)
        return [{
            "sessionId": s["sessionId"], "title": s.get("title") or "Nueva conversación",
            "updatedAt": s.get("updatedAt", ""), "messageCount": int(s.get("messageCount", 0)),
        } for s in sessions]

    def get_messages(self, user_id: str, session_id: str) -> list[dict[str, Any]]:
        if not self._db.get_session(user_id, session_id):
            raise ValidationError("La conversación no existe.")
        msgs = self._db.list_messages(session_id)
        msgs.sort(key=lambda m: m.get("createdAt", ""))
        return [{"role": m.get("role"), "text": m.get("content", ""), "createdAt": m.get("createdAt", "")}
                for m in msgs]

    def get_conversation(self, user_id: str, session_id: str) -> dict[str, Any]:
        """Mensajes + estado de la sesión, para el polling del frontend: mientras
        `status` sea "generating" hay una respuesta en camino."""
        session = self._db.get_session(user_id, session_id)
        if not session:
            raise ValidationError("La conversación no existe.")
        return {
            "messages": self.get_messages(user_id, session_id),
            "status": session.get("status", "ready"),
        }

    def delete_session(self, user_id: str, session_id: str) -> None:
        if not self._db.get_session(user_id, session_id):
            raise ValidationError("La conversación no existe.")
        self._db.delete_session(user_id, session_id)

    def send_message(self, user_id: str, session_id: str | None, text: str,
                     function_name: str) -> dict[str, Any]:
        """Encola el mensaje y dispara la generación EN SEGUNDO PLANO (self-invoke,
        mismo patrón que el escaneo de Athena): la respuesta del razonador puede
        tardar más que los 30 s duros de API Gateway, así que este POST regresa de
        inmediato con `pending` y el frontend sondea los mensajes hasta que llegue
        la respuesta del asistente."""
        text = (text or "").strip()
        if not text:
            raise ValidationError("El mensaje no puede estar vacío.")
        if len(text) > MAX_TEXT_CHARS:
            raise ValidationError(f"El mensaje supera el máximo de {MAX_TEXT_CHARS} caracteres.")

        now = _now()
        is_new = not session_id
        if is_new:
            session_id = uuid4().hex
            title = text[:TITLE_MAX_CHARS] + ("…" if len(text) > TITLE_MAX_CHARS else "")
            created_at = now
            message_count = 1
        else:
            session = self._db.get_session(user_id, session_id)
            if not session:
                raise ValidationError("La conversación no existe.")
            if session.get("status") == "generating":
                raise ValidationError("Espera la respuesta anterior antes de enviar otro mensaje.")
            title = session.get("title") or text[:TITLE_MAX_CHARS]
            created_at = session.get("createdAt", now)
            message_count = int(session.get("messageCount", 0)) + 1

        ttl = int(datetime.now(timezone.utc).timestamp()) + MESSAGE_TTL_DAYS * 86400
        self._db.put_message(session_id, "user", text, now, ttl)
        self._db.put_session(user_id, session_id, title, created_at, now, message_count,
                             status="generating")
        boto3.client("lambda").invoke(
            FunctionName=function_name, InvocationType="Event",
            Payload=json.dumps({"action": "chat_reply", "userId": user_id,
                                "sessionId": session_id}).encode())
        # Detección inmediata de antipatrones (determinística, ms): el frontend la
        # muestra mientras el modelo genera, para que la espera se sienta corta.
        try:
            detected = _detect_antipatterns(text)
        except Exception:
            detected = []
        return {"sessionId": session_id, "title": title, "pending": True,
                "antipatterns": detected}

    def run_reply(self, user_id: str, session_id: str) -> None:
        """Worker asíncrono: genera la respuesta con el razonador SIN límite de 30 s
        (la Lambda tiene 300 s). Pase lo que pase deja la sesión fuera del estado
        `generating` — si el modelo falla, guarda un mensaje de error visible para
        que el usuario pueda reintentar, en vez de dejar el chat colgado."""
        session = self._db.get_session(user_id, session_id)
        if not session:
            return
        msgs = self.get_messages(user_id, session_id)
        ttl = int(datetime.now(timezone.utc).timestamp()) + MESSAGE_TTL_DAYS * 86400
        try:
            convo = [{"role": m["role"], "text": m["text"]} for m in msgs[-MAX_HISTORY_MESSAGES:]]
            # Si la conversación menciona queries/tablas del data lake, se adjunta al
            # system prompt el MISMO contexto de catálogo que usa la Sugerencia IA de
            # Athena (formato, particiones, columnas con tipo, resolución de tablas
            # sin base) — así el chat sugiere con esa calidad sin pedirle el esquema
            # al usuario. Va en el system (no se guarda en el historial) y se
            # recalcula en cada turno sobre la ventana vigente de mensajes.
            system = SYSTEM_PROMPT
            user_texts = [m["text"] for m in convo if m["role"] == "user"]
            try:
                ctx_block = context_for_chat_texts(user_texts)
            except Exception:
                ctx_block = ""
            if ctx_block:
                system += (
                    "\n\nContexto del catálogo de datos de la plataforma para las tablas "
                    "mencionadas en la conversación (obtenido automáticamente; el usuario "
                    "no lo ve). Úsalo para precisar tus sugerencias con los tipos, "
                    "particiones y formato REALES — no inventes columnas ni particiones "
                    "que no estén aquí:\n" + ctx_block)
            # Mismo detector determinístico del monitoreo, sobre el SQL más reciente
            # de la conversación: el modelo debe abordar TODOS estos hallazgos (o
            # decir por qué alguno no aplica), no solo los que note por su cuenta.
            try:
                detected = next((d for d in (_detect_antipatterns(t) for t in reversed(user_texts)) if d), [])
            except Exception:
                detected = []
            if detected:
                system += (
                    "\n\nAntipatrones detectados automáticamente en el query del usuario "
                    "(detector determinístico de la plataforma, ya se le mostraron al "
                    "usuario): " + ", ".join(detected) + ". Aborda cada uno en tu "
                    "respuesta — corrígelo o explica por qué no aplica en este caso.")
            result = LlmService().converse(convo, system=system, max_tokens=1500,
                                           max_prompt_chars=16000)
            reply = result["text"]
            if result.get("stopReason") == "max_tokens":
                reply += "\n\n*(La respuesta se cortó por longitud; pídeme continuar o enfoca la pregunta.)*"
        except Exception:
            reply = "No pude generar la respuesta esta vez. Intenta enviar tu mensaje de nuevo."
        reply_at = _now()
        self._db.put_message(session_id, "assistant", reply, reply_at, ttl)
        self._db.put_session(user_id, session_id, session.get("title", ""),
                             session.get("createdAt", reply_at), reply_at,
                             len(msgs) + 1, status="ready")
