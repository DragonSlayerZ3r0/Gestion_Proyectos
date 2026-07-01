from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from core.errors import ValidationError
from repositories.chat import ChatRepository
from services.llm import LlmService

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

    def delete_session(self, user_id: str, session_id: str) -> None:
        if not self._db.get_session(user_id, session_id):
            raise ValidationError("La conversación no existe.")
        self._db.delete_session(user_id, session_id)

    def send_message(self, user_id: str, session_id: str | None, text: str) -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            raise ValidationError("El mensaje no puede estar vacío.")
        if len(text) > MAX_TEXT_CHARS:
            raise ValidationError(f"El mensaje supera el máximo de {MAX_TEXT_CHARS} caracteres.")

        now = _now()
        is_new = not session_id
        if is_new:
            session_id = uuid4().hex
            history: list[dict[str, Any]] = []
            title = text[:TITLE_MAX_CHARS] + ("…" if len(text) > TITLE_MAX_CHARS else "")
            created_at = now
        else:
            session = self._db.get_session(user_id, session_id)
            if not session:
                raise ValidationError("La conversación no existe.")
            history = self.get_messages(user_id, session_id)
            title = session.get("title") or text[:TITLE_MAX_CHARS]
            created_at = session.get("createdAt", now)

        ttl = int(datetime.now(timezone.utc).timestamp()) + MESSAGE_TTL_DAYS * 86400
        self._db.put_message(session_id, "user", text, now, ttl)

        convo = history[-MAX_HISTORY_MESSAGES:] + [{"role": "user", "text": text}]
        # Tope más bajo que el default (chat.py): el historial se reenvía completo en
        # CADA turno, así que el costo se acumula con la conversación — a diferencia
        # de la sugerencia de Athena, que es una sola llamada.
        result = LlmService().converse(convo, system=SYSTEM_PROMPT, max_tokens=900, max_prompt_chars=16000)
        reply = result["text"]

        reply_at = _now()
        self._db.put_message(session_id, "assistant", reply, reply_at, ttl)
        self._db.put_session(user_id, session_id, title, created_at, reply_at, len(history) + 2)

        return {"sessionId": session_id, "reply": reply, "title": title}
