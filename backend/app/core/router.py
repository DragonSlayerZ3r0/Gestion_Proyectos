"""Router minimalista por plantillas. Cada módulo registra sus rutas; el handler
solo despacha. Agregar un módulo = registrar rutas, sin tocar este archivo."""
from typing import Any, Callable

from core import guards
from core.errors import UserNotConfiguredError, ValidationError
from core.request import Request
from responses import error, success

Handler = Callable[[Request], dict[str, Any]]


class Route:
    def __init__(self, methods: list[str], template: str, handler: Handler,
                 modules: list[str] | None = None, admin: bool = False,
                 auth: bool = True, error_msg: str = "Error inesperado.") -> None:
        self.methods = {m.upper() for m in methods}
        self.template = template
        self.segments = [s for s in template.split("/") if s != ""]
        self.handler = handler
        self.modules = modules
        self.admin = admin
        self.auth = auth
        self.error_msg = error_msg

    def match(self, path_segments: list[str]) -> tuple[int, dict[str, str]] | None:
        """Devuelve (score_literales, params) si la ruta calza, o None.
        El score permite que un literal (p.ej. /sync) gane sobre un parámetro."""
        if len(path_segments) != len(self.segments):
            return None
        params: dict[str, str] = {}
        score = 0
        for seg, value in zip(self.segments, path_segments):
            if seg.startswith("{") and seg.endswith("}"):
                params[seg[1:-1]] = value
            elif seg == value:
                score += 1
            else:
                return None
        return score, params


class Router:
    def __init__(self) -> None:
        self.routes: list[Route] = []

    def add(self, methods: list[str], template: str, handler: Handler, **kwargs: Any) -> None:
        self.routes.append(Route(methods, template, handler, **kwargs))

    def dispatch(self, request: Request) -> dict[str, Any]:
        segments = [s for s in request.path.split("/") if s != ""]
        path_matches = []
        for route in self.routes:
            matched = route.match(segments)
            if matched is not None:
                path_matches.append((route, matched[0], matched[1]))

        if not path_matches:
            return error("NOT_FOUND", "Ruta no encontrada.", 404)

        method_matches = [t for t in path_matches if request.method in t[0].methods]
        if not method_matches:
            return error("METHOD_NOT_ALLOWED", "Método no permitido.", 405)

        route, _, params = max(method_matches, key=lambda t: t[1])
        request.params = {**request.params, **params}
        return self._invoke(route, request)

    def _invoke(self, route: Route, request: Request) -> dict[str, Any]:
        # Autenticación primero: un fallo de JWT es 401, distinto de un error de
        # negocio (que abajo se traduce a 404/400).
        if route.auth:
            try:
                request.identity
            except ValueError as exc:
                return error("UNAUTHORIZED", str(exc), 401)
        try:
            if route.modules:
                guards.ensure_module_access(request.identity, route.modules)
            if route.admin:
                guards.ensure_admin(request.identity)
            return route.handler(request)
        except UserNotConfiguredError as exc:
            return error("USER_NOT_CONFIGURED", str(exc), 403)
        except PermissionError as exc:
            return error("FORBIDDEN", str(exc), 403)
        except ValidationError as exc:
            return error("VALIDATION_ERROR", str(exc), 400)
        except ValueError as exc:
            # Error de negocio "no encontrado" (p. ej. catálogo).
            return error("NOT_FOUND", str(exc), 404)
        except Exception:
            return error("INTERNAL_ERROR", route.error_msg, 500)
