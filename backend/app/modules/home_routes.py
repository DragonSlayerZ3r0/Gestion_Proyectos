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


def _cost_accounts(req: Request):
    return success({"accounts": HomeService().list_cost_accounts()})


def _cost_detail(req: Request):
    account = req.query.get("account") or ""
    service = req.query.get("service") or ""
    start = req.query.get("start") or ""
    end = req.query.get("end") or ""
    force = req.query.get("force") == "1"
    return success(HomeService().get_service_detail(account, service, start, end, force))


def _cost_daily(req: Request):
    account = req.query.get("account") or ""
    start = req.query.get("start") or ""
    end = req.query.get("end") or ""
    force = req.query.get("force") == "1"
    cached_only = req.query.get("cachedOnly") == "1"
    return success(HomeService().get_daily_by_service(account, start, end, force, cached_only))


def register(router: Router) -> None:
    router.add(["GET"], "/api/home/summary", _summary, modules=["home"],
               error_msg="Error inesperado al cargar el resumen.")
    # Los costos son sensibles: además del módulo home, exige rol admin.
    router.add(["GET"], "/api/home/costs", _costs, modules=["home"], admin=True,
               error_msg="Error inesperado al cargar los costos.")
    # Lista de cuentas para el selector (también admin-only).
    router.add(["GET"], "/api/home/cost-accounts", _cost_accounts, modules=["home"], admin=True,
               error_msg="Error inesperado al cargar las cuentas.")
    # Detalle de un servicio por tipo de uso (admin-only).
    router.add(["GET"], "/api/home/costs/detail", _cost_detail, modules=["home"], admin=True,
               error_msg="Error inesperado al cargar el detalle del servicio.")
    # Costo diario por servicio para detección de picos (admin-only).
    router.add(["GET"], "/api/home/costs/daily", _cost_daily, modules=["home"], admin=True,
               error_msg="Error inesperado al cargar el costo diario.")
