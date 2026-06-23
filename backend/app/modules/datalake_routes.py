from core.request import Request
from core.router import Router
from responses import success
from services.datalake import DatalakeService


def _ingest(req: Request):
    bucket = req.query.get("bucket") or ""
    return success(DatalakeService().get_overview(bucket, req.lambda_context.function_name))


def _ingest_scan(req: Request):
    bucket = req.query.get("bucket") or ""
    return success(DatalakeService().start_scan(bucket, req.lambda_context.function_name))


def _ingest_detail(req: Request):
    bucket = req.query.get("bucket") or ""
    zone = req.query.get("zone") or ""
    return success(DatalakeService().get_zone_detail(bucket, zone))


def _buckets(req: Request):
    return success({"buckets": DatalakeService().list_buckets()})


def register(router: Router) -> None:
    # Monitoreo de cargas del data lake (pestaña Data Lake del módulo Inicio).
    M = ["home"]
    router.add(["GET"], "/api/datalake/buckets", _buckets, modules=M,
               error_msg="Error al cargar los buckets monitoreados.")
    router.add(["GET"], "/api/datalake/ingest", _ingest, modules=M,
               error_msg="Error al cargar el monitoreo de cargas.")
    router.add(["POST"], "/api/datalake/ingest/scan", _ingest_scan, modules=M,
               error_msg="Error al iniciar el escaneo de cargas.")
    router.add(["GET"], "/api/datalake/ingest/detail", _ingest_detail, modules=M,
               error_msg="Error al cargar el detalle por área.")
