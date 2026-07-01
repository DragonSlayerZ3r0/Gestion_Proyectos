from core.request import Request
from core.router import Router
from responses import success
from services.chat import ChatService


def _list_sessions(req: Request):
    return success({"sessions": ChatService().list_sessions(req.identity["userId"])})


def _get_messages(req: Request):
    session_id = req.params.get("sessionId") or ""
    return success({"messages": ChatService().get_messages(req.identity["userId"], session_id)})


def _delete_session(req: Request):
    session_id = req.params.get("sessionId") or ""
    ChatService().delete_session(req.identity["userId"], session_id)
    return success({"deleted": True})


def _send_message(req: Request):
    body = req.body()
    session_id = body.get("sessionId") or None
    text = body.get("text") or ""
    return success(ChatService().send_message(req.identity["userId"], session_id, text))


def register(router: Router) -> None:
    # Apoyo técnico: chat con LLM (Fase 3). Habilitado por módulo, no admin-only.
    router.add(["GET"], "/api/chat/sessions", _list_sessions, modules=["chat"],
               error_msg="Error al cargar las conversaciones.")
    router.add(["GET"], "/api/chat/sessions/{sessionId}/messages", _get_messages, modules=["chat"],
               error_msg="Error al cargar la conversación.")
    router.add(["DELETE"], "/api/chat/sessions/{sessionId}", _delete_session, modules=["chat"],
               error_msg="Error al eliminar la conversación.")
    router.add(["POST"], "/api/chat/messages", _send_message, modules=["chat"],
               error_msg="Error al enviar el mensaje.")
