import time
from typing import Any

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository

# Las conexiones muertas que se escapen del $disconnect expiran solas por TTL.
_CONN_TTL_SECONDS = 12 * 60 * 60


class DrawWsRepository(BaseRepository):
    """Conexiones WebSocket de las salas de Pizarra. Dos items por conexión:
    - Miembro de sala  PK=DRAWROOM#<drawingId>  SK=CONN#<connectionId>  → para el fan-out.
    - Reverso          PK=DRAWCONN#<connectionId> SK=META               → para saber, en
      $disconnect/mensaje (que solo traen connectionId), a qué sala pertenece."""

    def add_connection(self, drawing_id: str, connection_id: str, user_id: str, user_name: str) -> None:
        ttl = int(time.time()) + _CONN_TTL_SECONDS
        base = {
            "entityType": "DRAW_CONNECTION",
            "drawingId": drawing_id,
            "connectionId": connection_id,
            "userId": user_id,
            "userName": user_name,
            "ttl": ttl,
        }
        self._table.put_item(Item={"PK": f"DRAWROOM#{drawing_id}", "SK": f"CONN#{connection_id}", **base})
        self._table.put_item(Item={"PK": f"DRAWCONN#{connection_id}", "SK": "META", **base})

    def get_connection(self, connection_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"DRAWCONN#{connection_id}", "SK": "META"})
        return response.get("Item")

    def list_room(self, drawing_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"DRAWROOM#{drawing_id}") & Key("SK").begins_with("CONN#"))

    def remove_connection(self, drawing_id: str, connection_id: str) -> None:
        self._table.delete_item(Key={"PK": f"DRAWROOM#{drawing_id}", "SK": f"CONN#{connection_id}"})
        self._table.delete_item(Key={"PK": f"DRAWCONN#{connection_id}", "SK": "META"})
