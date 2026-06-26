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


def _ingest_records(req: Request):
    bucket = req.query.get("bucket") or ""
    zone = req.query.get("zone") or ""
    # Drill "Por fecha → área → tablas": misma ruta con area+day (evita sumar otra
    # ruta a API Gateway; el resource policy del Lambda ya está al límite).
    area = req.query.get("area") or ""
    day = req.query.get("day") or ""
    if area and day:
        return success(DatalakeService().get_day_tables(bucket, zone, area, day))
    start = req.query.get("start") or ""
    end = req.query.get("end") or ""
    return success(DatalakeService().get_records(
        bucket, zone, start, end, req.lambda_context.function_name))


def _ingest_records_scan(req: Request):
    bucket = req.query.get("bucket") or ""
    zone = req.query.get("zone") or ""
    start = req.query.get("start") or ""
    end = req.query.get("end") or ""
    return success(DatalakeService().start_records_scan(
        bucket, zone, start, end, req.lambda_context.function_name))


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
    router.add(["GET"], "/api/datalake/ingest/records", _ingest_records, modules=M,
               error_msg="Error al cargar los registros por área.")
    router.add(["POST"], "/api/datalake/ingest/records/scan", _ingest_records_scan, modules=M,
               error_msg="Error al iniciar el conteo de registros.")
