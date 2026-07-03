from core.request import Request
from core.router import Router
from responses import success
from services.athena_monitor import AthenaMonitorService


def _usage(req: Request):
    # Con `qid` devuelve el SQL completo de esa consulta (bajo demanda); si no, el
    # agregado por usuario de la ventana.
    qid = req.query.get("qid") or ""
    if qid:
        return success(AthenaMonitorService().get_query_sql(qid))
    start = req.query.get("start") or ""
    end = req.query.get("end") or ""
    ap_user = req.query.get("apUser") or ""
    if ap_user:
        return success(AthenaMonitorService().get_user_antipatterns(start, end, ap_user))
    force = bool(req.query.get("force"))
    return success(AthenaMonitorService().get_usage(start, end, req.lambda_context.function_name, force=force))


def _suggest(req: Request):
    qid = req.body().get("qid") or ""
    return success(AthenaMonitorService().suggest_fix(qid))


def register(router: Router) -> None:
    # Monitoreo de consumo de Athena (pestaña Athena de Inicio): exige la pestaña
    # "Inicio · Athena" asignada en Administración; sin configurar → solo admins
    # (comportamiento previo, ver guards.ensure_home_tab).
    router.add(["GET"], "/api/home/athena", _usage, modules=["home"], home_tab="home_athena",
               error_msg="Error al cargar el consumo de Athena.")
    # Sugerencia de un LLM para una consulta puntual con antipatrones (bajo demanda).
    router.add(["POST"], "/api/home/athena/suggest", _suggest, modules=["home"], home_tab="home_athena",
               error_msg="Error al generar la sugerencia.")
