"""Descubre y registra las rutas de cada módulo automáticamente.
Para agregar un módulo nuevo basta crear `modules/<algo>_routes.py` con una
función `register(router)`; no hay que tocar el núcleo ni el handler."""
import importlib
import pkgutil

from core.router import Router


def build_router() -> Router:
    router = Router()
    import modules as _pkg
    for info in pkgutil.iter_modules(_pkg.__path__):
        if not info.name.endswith("_routes"):
            continue
        module = importlib.import_module(f"modules.{info.name}")
        register = getattr(module, "register", None)
        if callable(register):
            register(router)
    return router
