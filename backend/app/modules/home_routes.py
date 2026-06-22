from core.request import Request
from core.router import Router
from responses import success
from services.home import HomeService


def _summary(req: Request):
    return success(HomeService().get_summary())


def _costs(req: Request):
    account = req.query.get("account") or ""
    start = req.query.get("start") or ""
    end = req.query.get("end") or ""
    force = req.query.get("force") == "1"
    return success(HomeService().get_costs(account, start, end, force))


def register(router: Router) -> None:
    router.add(["GET"], "/api/home/summary", _summary, modules=["home"],
               error_msg="Error inesperado al cargar el resumen.")
    # Los costos son sensibles: además del módulo home, exige rol admin.
    router.add(["GET"], "/api/home/costs", _costs, modules=["home"], admin=True,
               error_msg="Error inesperado al cargar los costos.")
