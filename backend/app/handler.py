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

    # Escaneo en segundo plano del monitoreo de cargas del data lake.
    if event.get("action") == "datalake_ingest_scan":
        from services.datalake import DatalakeService
        DatalakeService().run_scan(event.get("bucket", ""))
        return {"ok": True}

    # Monitoreo de consumo de Athena por usuario (CloudTrail + Athena), por ventana.
    if event.get("action") == "athena_usage_scan":
        from services.athena_monitor import AthenaMonitorService
        AthenaMonitorService().run_scan(event.get("start", ""), event.get("end", ""))
        return {"ok": True}

    # Respuesta del chat de apoyo técnico en segundo plano: el razonador puede
    # tardar más que los 30 s de API Gateway, así que el POST encola y esto genera.
    if event.get("action") == "chat_reply":
        from services.chat import ChatService
        ChatService().run_reply(event.get("userId", ""), event.get("sessionId", ""))
        return {"ok": True}

    # Conteo de filas por área/tabla (tabla de control vía Athena), acotado a un rango.
    if event.get("action") == "datalake_records_scan":
        from services.datalake import DatalakeService
        DatalakeService().run_records_scan(
            event.get("bucket", ""), event.get("zone", ""),
            event.get("start", ""), event.get("end", ""))
        return {"ok": True}

    return _router.dispatch(Request(event, context))
