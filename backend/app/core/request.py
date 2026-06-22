import json
from typing import Any

from auth import get_user_identity
from core.errors import ValidationError


class Request:
    """Envuelve el evento de API Gateway y expone lo que un handler necesita.
    La identidad se resuelve de forma perezosa (y se cachea) para que las rutas
    públicas no exijan JWT."""

    def __init__(self, event: dict[str, Any], lambda_context: Any) -> None:
        self.event = event
        self.lambda_context = lambda_context
        self.method = event.get("requestContext", {}).get("http", {}).get("method", "")
        self.path = event.get("rawPath", "")
        self.params: dict[str, str] = event.get("pathParameters") or {}
        self.query: dict[str, str] = event.get("queryStringParameters") or {}
        self._identity: dict[str, str] | None = None

    @property
    def identity(self) -> dict[str, str]:
        if self._identity is None:
            self._identity = get_user_identity(self.event)
        return self._identity

    def body(self) -> dict[str, Any]:
        raw = self.event.get("body")
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValidationError("El cuerpo de la solicitud no es JSON válido.") from exc
        if not isinstance(parsed, dict):
            raise ValidationError("El cuerpo de la solicitud debe ser un objeto JSON.")
        return parsed
