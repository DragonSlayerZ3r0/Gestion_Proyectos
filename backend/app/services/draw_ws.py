"""Colaboración en vivo de Pizarra sobre API Gateway WebSocket (serverless).

Cada tablero es una "sala". El servidor solo RELEVA mensajes entre los
participantes (no interpreta la escena — eso vive en los navegadores):

  Cliente → servidor:
    hello          al conectar: pido la lista de miembros y la escena actual
    init-response  respondo con mi escena al recién llegado ({to: connId, elements, files})
    scene          difundo mis elementos cambiados a los demás
    pointer        difundo la posición de mi cursor a los demás

  Servidor → clientes:
    members     al recién llegado: quiénes ya están en la sala
    join/leave  a los demás: alguien entró / salió (para cursores y presencia)
    init-request a un miembro: "mándale tu escena al recién llegado {from: connId}"
    scene/pointer/init-response  reenvíos, con senderId/senderName/senderConn añadidos

Autorización: el token (access token de Cognito) viaja como query param en el
handshake (el navegador no puede mandar headers en WS) y se valida en $connect
con `GetUser` (sin librerías de cripto). El acceso al tablero reusa el modelo de
compartir existente (dueño o invitado que aceptó).
"""
import json
from typing import Any

import boto3

from repositories.draw_ws import DrawWsRepository
from repositories.drawings import DrawingsRepository
from services.name_directory import NameDirectory

_REGION = "us-east-1"


class DrawWsService:
    # ── $connect ──────────────────────────────────────────────────────────────
    def handle_connect(self, event: dict[str, Any]) -> dict[str, Any]:
        ctx = event["requestContext"]
        connection_id = ctx["connectionId"]
        qs = event.get("queryStringParameters") or {}
        token = qs.get("token") or ""
        drawing_id = (qs.get("drawingId") or "").strip()
        if not token or not drawing_id:
            return {"statusCode": 400}

        email = self._email_from_token(token)
        if not email:
            return {"statusCode": 401}

        drawings = DrawingsRepository()
        drawing = drawings.get_drawing(drawing_id)
        if not drawing:
            return {"statusCode": 403}
        if drawing.get("ownerUserId") != email:
            share = drawings.get_share(drawing_id, email)
            if not share or share.get("status") != "accepted":
                return {"statusCode": 403}

        name = NameDirectory().resolve([email]).get(email, "") or email
        DrawWsRepository().add_connection(drawing_id, connection_id, email, name)
        # Avisar a los que ya estaban (el recién llegado se excluye).
        self._broadcast(event, drawing_id,
                        {"type": "join", "senderConn": connection_id, "senderId": email, "senderName": name},
                        exclude=connection_id)
        return {"statusCode": 200}

    # ── $disconnect ───────────────────────────────────────────────────────────
    def handle_disconnect(self, event: dict[str, Any]) -> dict[str, Any]:
        connection_id = event["requestContext"]["connectionId"]
        repo = DrawWsRepository()
        meta = repo.get_connection(connection_id)
        if meta:
            drawing_id = meta.get("drawingId", "")
            repo.remove_connection(drawing_id, connection_id)
            self._broadcast(event, drawing_id,
                            {"type": "leave", "senderConn": connection_id, "senderId": meta.get("userId", "")},
                            exclude=connection_id)
        return {"statusCode": 200}

    # ── mensajes ($default) ───────────────────────────────────────────────────
    def handle_message(self, event: dict[str, Any]) -> dict[str, Any]:
        connection_id = event["requestContext"]["connectionId"]
        repo = DrawWsRepository()
        meta = repo.get_connection(connection_id)
        if not meta:
            return {"statusCode": 200}
        drawing_id = meta["drawingId"]
        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return {"statusCode": 200}
        if not isinstance(body, dict):
            return {"statusCode": 200}

        body["senderConn"] = connection_id
        body["senderId"] = meta.get("userId", "")
        body["senderName"] = meta.get("userName", "")
        mtype = body.get("type")

        if mtype == "hello":
            members = [
                {"connectionId": c["connectionId"], "userId": c.get("userId", ""), "userName": c.get("userName", "")}
                for c in repo.list_room(drawing_id) if c["connectionId"] != connection_id
            ]
            self._send(event, connection_id, {"type": "members", "members": members})
            if members:  # pedir la escena a UN miembro; su respuesta irá al recién llegado
                self._send(event, members[0]["connectionId"], {"type": "init-request", "from": connection_id})
            return {"statusCode": 200}

        if mtype == "init-response":
            target = body.get("to")
            if target:
                self._send(event, target, body)
            return {"statusCode": 200}

        # scene / pointer / otros → difundir a los demás de la sala.
        self._broadcast(event, drawing_id, body, exclude=connection_id)
        return {"statusCode": 200}

    # ── Cognito: validar el access token sin librerías de cripto ──────────────
    def _email_from_token(self, token: str) -> str:
        try:
            user = boto3.client("cognito-idp", region_name=_REGION).get_user(AccessToken=token)
        except Exception:  # noqa: BLE001 — token inválido/vencido → rechazar conexión
            return ""
        for attr in user.get("UserAttributes", []):
            if attr.get("Name") == "email":
                return (attr.get("Value") or "").strip().lower()
        return (user.get("Username") or "").strip().lower()

    # ── Empuje de mensajes (ApiGatewayManagementApi) ──────────────────────────
    def _mgmt(self, event: dict[str, Any]):
        ctx = event["requestContext"]
        return boto3.client("apigatewaymanagementapi", region_name=_REGION,
                            endpoint_url=f"https://{ctx['domainName']}/{ctx['stage']}")

    def _send(self, event: dict[str, Any], connection_id: str, payload: dict[str, Any]) -> None:
        self._post(self._mgmt(event), connection_id, payload)

    def _broadcast(self, event: dict[str, Any], drawing_id: str, payload: dict[str, Any],
                   exclude: str | None = None) -> None:
        client = self._mgmt(event)
        data = json.dumps(payload, default=str).encode()
        for conn in DrawWsRepository().list_room(drawing_id):
            cid = conn["connectionId"]
            if cid != exclude:
                self._post(client, cid, payload, data=data)

    def _post(self, client, connection_id: str, payload: dict[str, Any], data: bytes | None = None) -> None:
        if data is None:
            data = json.dumps(payload, default=str).encode()
        try:
            client.post_to_connection(ConnectionId=connection_id, Data=data)
        except client.exceptions.GoneException:
            meta = DrawWsRepository().get_connection(connection_id)  # conexión muerta → limpiar
            if meta:
                DrawWsRepository().remove_connection(meta.get("drawingId", ""), connection_id)
        except Exception:  # noqa: BLE001 — un envío fallido no debe tumbar el resto del fan-out
            pass
