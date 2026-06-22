from typing import Any

from core.request import Request
from modules import build_router
from services.catalog import CatalogService

# El router se arma una vez por cold start descubriendo los módulos.
_router = build_router()


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    # EventBridge scheduled trigger o auto-invocación asíncrona (no es HTTP).
    if event.get("action") == "catalog_sync_all" or event.get("source") == "aws.events":
        CatalogService().run_sync_all()
        return {"ok": True}

    return _router.dispatch(Request(event, context))
