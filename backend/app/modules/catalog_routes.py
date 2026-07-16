from core.request import Request
from core.router import Router
from responses import success
from services.catalog import CatalogService

C = ["catalog"]
SYNC_ERR = "Error inesperado durante la sincronización."


def _svc(req: Request) -> CatalogService:
    # Todas las rutas aceptan ?account= (whitelist CATALOG_ACCOUNTS); sin el
    # parámetro operan sobre la cuenta default (el hub del data lake).
    return CatalogService(req.query.get("account"))


def _list_databases(req: Request):
    return success(_svc(req).list_databases())


def _sync_all(req: Request):
    started_at = _svc(req).start_sync_all(req.lambda_context.function_name)
    return success({"started": True, "startedAt": started_at})


def _database_tables(req: Request):
    database = req.params.get("database") or ""
    if req.query.get("stats") == "1":
        return success(_svc(req).get_database_info(database, include_stats=True))
    return success(_svc(req).list_tables(database))


def _search(req: Request):
    # Búsqueda AVANZADA (semántica) sobre TODO el catálogo de la cuenta.
    return success(_svc(req).search_semantic(req.query.get("q") or "",
                                             limit=int(req.query.get("limit") or 40)))


def _sync_database(req: Request):
    return success(_svc(req).sync_database(req.params.get("database") or ""))


def _table(req: Request):
    database = req.params.get("database") or ""
    table = req.params.get("table") or ""
    include_stats = req.query.get("stats") == "1"
    return success(_svc(req).get_table(database, table, include_stats=include_stats))


def _sync_table(req: Request):
    return success(_svc(req).sync_table(req.params.get("database") or "", req.params.get("table") or ""))


def _table_usage(req: Request):
    database = req.params.get("database") or ""
    table = req.params.get("table") or ""
    return success(_svc(req).get_table_usage(database, table))


def _table_context(req: Request):
    database = req.params.get("database") or ""
    table = req.params.get("table") or ""
    return success(_svc(req).save_table_context(database, table, req.body(), req.identity))


def _column_context(req: Request):
    database = req.params.get("database") or ""
    table = req.params.get("table") or ""
    column = req.params.get("column") or ""
    return success(_svc(req).save_column_context(database, table, column, req.body(), req.identity))


def register(router: Router) -> None:
    router.add(["GET"], "/api/catalog", _list_databases, modules=C,
               error_msg="Error inesperado al listar bases de datos.")
    router.add(["POST"], "/api/catalog/sync", _sync_all, modules=C, error_msg=SYNC_ERR)
    # Ruta literal ANTES de {database}: el router prioriza literales, así "search"
    # no se confunde con un nombre de base de datos.
    router.add(["GET"], "/api/catalog/search", _search, modules=C,
               error_msg="Error inesperado en la búsqueda.")
    router.add(["GET"], "/api/catalog/{database}", _database_tables, modules=C,
               error_msg="Error inesperado al listar tablas.")
    router.add(["POST"], "/api/catalog/{database}/sync", _sync_database, modules=C, error_msg=SYNC_ERR)
    router.add(["GET"], "/api/catalog/{database}/{table}/usage", _table_usage, modules=C,
               error_msg="Error al cargar el uso reciente de la tabla.")
    router.add(["GET"], "/api/catalog/{database}/{table}", _table, modules=C,
               error_msg="Error inesperado al obtener la tabla.")
    router.add(["POST"], "/api/catalog/{database}/{table}/sync", _sync_table, modules=C, error_msg=SYNC_ERR)
    router.add(["PUT"], "/api/catalog/{database}/{table}/context", _table_context, modules=C,
               error_msg="Error inesperado al guardar el contexto.")
    router.add(["PUT"], "/api/catalog/{database}/{table}/columns/{column}/context", _column_context, modules=C,
               error_msg="Error inesperado al guardar el contexto de columna.")
