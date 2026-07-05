from typing import Any
from uuid import uuid4

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository

# Sesión: PK=USER#<userId>, SK=CHAT#<sessionId> (lista de un usuario = query por PK).
# Mensajes de esa sesión: PK=CHAT#<sessionId>, SK=MSG#<createdAt>#<sufijo> (orden
# cronológico natural). Dos prefijos de PK distintos porque se consultan por
# separado (lista de sesiones vs. mensajes de una), igual que CATALOG#/TABLE#.


class ChatRepository(BaseRepository):
    def list_sessions(self, user_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"USER#{user_id}") & Key("SK").begins_with("CHAT#"))

    def get_session(self, user_id: str, session_id: str) -> dict[str, Any] | None:
        resp = self._table.get_item(Key={"PK": f"USER#{user_id}", "SK": f"CHAT#{session_id}"})
        return resp.get("Item")

    def put_session(self, user_id: str, session_id: str, title: str, created_at: str,
                     updated_at: str, message_count: int, status: str = "ready") -> None:
        # status: "generating" mientras el worker asíncrono produce la respuesta
        # (el POST regresa antes de tenerla); "ready" cuando ya está guardada.
        self._table.put_item(Item={
            "PK": f"USER#{user_id}", "SK": f"CHAT#{session_id}",
            "entityType": "CHAT_SESSION",
            "sessionId": session_id, "userId": user_id, "title": title,
            "createdAt": created_at, "updatedAt": updated_at, "messageCount": message_count,
            "status": status,
        })

    def delete_session(self, user_id: str, session_id: str) -> None:
        self._table.delete_item(Key={"PK": f"USER#{user_id}", "SK": f"CHAT#{session_id}"})
        msgs = self.list_messages(session_id)
        with self._table.batch_writer() as batch:
            for m in msgs:
                batch.delete_item(Key={"PK": m["PK"], "SK": m["SK"]})

    def list_messages(self, session_id: str) -> list[dict[str, Any]]:
        return self._query_all(KeyConditionExpression=Key("PK").eq(f"CHAT#{session_id}"))

    def put_message(self, session_id: str, role: str, text: str, created_at: str, ttl: int) -> None:
        sk = f"MSG#{created_at}#{uuid4().hex[:6]}"
        self._table.put_item(Item={
            "PK": f"CHAT#{session_id}", "SK": sk,
            "entityType": "CHAT_MESSAGE",
            "role": role, "content": text, "createdAt": created_at, "ttl": ttl,
        })
