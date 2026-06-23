# Guía: agregar un módulo nuevo

Arquitectura modular: un módulo se agrega **sin tocar el núcleo**. Backend y frontend
siguen el mismo principio (módulos enchufables por registro / inyección de dependencias).

Ejemplo: un módulo nuevo `reports` (Reportes).

## 1. Registrar la clave del módulo (autorización)

Editar `backend/app/modules/manifest.py` y agregar la clave a `MODULES`:

```python
{"key": "reports", "label": "Reportes"},
```

Es la **fuente única**: de aquí salen los módulos por defecto y las validaciones.
Para que un usuario lo vea, habilitárselo desde el módulo **Administración** (o crear el
item `USER#<email> / MODULE#reports`).

## 2. Backend — servicio, repositorio y rutas

1. **Servicio** `backend/app/services/reports.py`: la lógica de negocio. Lanza
   `ValidationError` (400) o `ValueError` (404) según el caso; el router las traduce.

2. **Repositorio** (si necesita datos propios) `backend/app/repositories/reports.py`:

   ```python
   from repositories.base import BaseRepository
   class ReportsRepository(BaseRepository):
       def list_reports(self): ...
   ```

   Hereda de `BaseRepository` (conexión a la tabla + helper `_update`). **Un repo por
   dominio**, no se toca ningún otro.

3. **Rutas** `backend/app/modules/reports_routes.py` con una función `register(router)`:

   ```python
   from core.request import Request
   from core.router import Router
   from responses import success
   from services.reports import ReportsService

   def _list(req: Request):
       return success(ReportsService().list_reports())

   def register(router: Router) -> None:
       router.add(["GET"], "/api/reports", _list, modules=["reports"],
                  error_msg="Error inesperado al listar reportes.")
   ```

   `build_router()` (`modules/__init__.py`) **autodescubre** cualquier archivo
   `*_routes.py` con `register`. No se edita `handler.py` ni `core/`.

   Guards declarativos en `router.add(...)`: `modules=[...]` exige el módulo habilitado;
   `admin=True` exige rol admin; `auth=False` para rutas públicas (como `/health`).

4. **Infra** `infra/lib/gestion-proyectos-stack.ts`: registrar la ruta en API Gateway
   (las rutas son explícitas con JWT Authorizer). Desplegar con `npm run infra:deploy`.

## 3. Frontend — módulo de UI

1. Crear `frontend/src/scripts/modules/reports.ts` con una factory que recibe sus
   dependencias por **inyección** (no accede a globales del shell):

   ```ts
   // @ts-nocheck
   export function createReportsModule(ctx) {
     const { state, elements, apiRequest, escapeHtml } = ctx;
     async function render() {
       elements.contentPanel.hidden = false;
       const { data } = await apiRequest("api/reports");
       elements.contentPanel.innerHTML = `...`;
     }
     return { render };
   }
   ```

2. En `frontend/src/scripts/app.ts` (el shell), importar, instanciar y delegar:

   ```ts
   import { createReportsModule } from "./modules/reports";
   const reportsModule = createReportsModule({ state, elements, apiRequest, escapeHtml });
   // dentro de renderModule(moduleKey):
   if (moduleKey === "reports") { reportsModule.render(); return; }
   ```

3. Agregar la entrada al menú: `defaultModules` y `moduleOrder` en `app.ts` (y a
   `viewCopy` si usa la tarjeta genérica).

### Sub-módulos (componer una sección dentro de otro módulo)

Si lo nuevo no es una entrada de menú sino una **sección dentro de un módulo existente**
(p. ej. una pestaña), aplica el mismo patrón pero el **módulo padre** lo compone en vez
del shell. Ejemplo real: el **Monitoreo de cargas** vive en la pestaña Data Lake del
módulo Inicio, así que se extrajo a `frontend/src/scripts/modules/datalake.ts`
(`createDatalakeModule(ctx)`) y el módulo Inicio lo instancia y le **delega**
`sectionHtml()`, `bindEvents()`, `drawChart()` y `ensure()`, pasándole un callback
`repaint` para re-renderizar. Así Inicio no se vuelve un "archivo dios" y la sección
mantiene una sola responsabilidad. En backend sigue siendo un dominio normal
(`services/datalake.py`, `repositories/datalake.py`, `modules/datalake_routes.py`).

## 4. Validar y publicar

- Backend: `python3 -m py_compile` de los archivos nuevos; desplegar (`npm run infra:deploy`);
  validar invocando la Lambda o por API.
- Frontend: `pnpm build` (Vite falla ante imports no resueltos) **y prueba en navegador**
  (con `@ts-nocheck`, una referencia global no definida solo falla en runtime). Publicar
  según `docs/17_desarrollo_local_publicacion.md`.

## Resumen de los puntos a tocar

| Pieza | Archivo | ¿Toca el núcleo? |
| --- | --- | --- |
| Clave del módulo | `backend/app/modules/manifest.py` | No (es la fuente única) |
| Servicio | `backend/app/services/<x>.py` | No |
| Repositorio | `backend/app/repositories/<x>.py` | No |
| Rutas backend | `backend/app/modules/<x>_routes.py` | No (autodescubierto) |
| Ruta API Gateway | `infra/lib/gestion-proyectos-stack.ts` | Sí (registro de ruta) |
| Módulo frontend | `frontend/src/scripts/modules/<x>.ts` | No |
| Wiring frontend | `frontend/src/scripts/app.ts` (3 líneas) | Mínimo |

Referencias: `docs/05_api_backend.md` (estructura backend), `docs/18_servicios_y_runtime.md`
(runtime), `docs/01_arquitectura_aws.md` (capas).
