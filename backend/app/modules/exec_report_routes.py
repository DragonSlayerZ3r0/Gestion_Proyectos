from core.request import Request
from core.router import Router
from responses import success
from services.exec_report import ExecReportService


def _start(req: Request):
    body = req.body()
    return success(ExecReportService().start(
        req.identity["userId"], body.get("kind") or "", body.get("text") or "",
        req.lambda_context.function_name))


def _get(req: Request):
    return success(ExecReportService().get(
        req.identity["userId"], req.params.get("reportId") or ""))


def register(router: Router) -> None:
    # Reporte ejecutivo de solicitudes (LLM, asíncrono). Mismo acceso que el módulo.
    router.add(["POST"], "/api/workspace/report", _start, modules=["projects", "tasks"],
               error_msg="Error al iniciar el reporte.")
    router.add(["GET"], "/api/workspace/report/{reportId}", _get, modules=["projects", "tasks"],
               error_msg="Error al consultar el reporte.")
