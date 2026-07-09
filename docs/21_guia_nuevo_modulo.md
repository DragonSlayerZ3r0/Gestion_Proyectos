# Guía: agregar un módulo nuevo

La arquitectura incorpora módulos mediante puntos de extensión estables. Backend y
frontend siguen el mismo principio: registro de rutas e inyección de dependencias.

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
   dominio** y mantiene aislada su persistencia.

   **Estándar de acceso a datos (obligatorio, verificado por `npm run check`):**
   - **Nunca** `self._table.query(...)` ni `self._table.scan(...)` directos — siempre
     `self._query_all(...)` / `self._scan_all(...)` (paginan hasta el final; una
     lectura de una página devuelve datos incompletos SIN error cuando la tabla
     crece — incidente 2026-07-03, ver `docs/04`). El guardrail
     `scripts/check-dynamo-pagination.sh` falla el build si aparece uno crudo.
   - **Listados globales por tipo** ("todas las X de la tabla") van por el GSI
     `byEntityType` vía `self._query_entity_type("MI_TIPO", filtro_extra)` — nunca un
     scan con filtro (lee toda la tabla para devolver un puñado de items). El helper
     ya trae fallback a scan paginado si el índice no está ACTIVE.
   - Todo item nuevo lleva **`entityType`** (así entra solo al GSI) y los borrados de
     items hijos usan lecturas paginadas antes del batch de deletes (sin huérfanos).
   - Si el item debe **expirar solo**, usar el atributo **`ttl`** (epoch segundos; TTL
     nativo ya habilitado en la tabla — lo usan chat y las ejecuciones de Athena).

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
   `*_routes.py` con `register`; `handler.py` y `core/` permanecen estables.

   Guards declarativos en `router.add(...)`: `modules=[...]` exige el módulo habilitado;
   `admin=True` exige rol admin; `auth=False` para rutas públicas (como `/health`).

4. **API Gateway**: la ruta catch-all `/api/{proxy+}` ya cubre los métodos privados
   `GET`, `POST`, `PATCH`, `PUT` y `DELETE` con JWT Authorizer. Registrar la ruta en el
   módulo backend la incorpora al API. `infra/` cambia únicamente cuando el módulo
   requiere infraestructura, permisos IAM o configuración adicional.

### Catálogos de valores (regla 2026-07-09)

Si el módulo tiene conjuntos de valores seleccionables (tipos, estados…), defínelos como **catálogo `{key, label}` en el servicio** y publícalos en el payload del GET principal; deriva de ahí la lista de claves para validación. El frontend recorre el catálogo en selects, filtros, chips y etiquetas (con un fallback local mínimo). Nunca escribas las opciones a mano en un `<select>` — agregar un valor debe ser tocar UN lugar. Referencias: `REQUEST_TYPES_CATALOG` en `services/workspace.py` y su consumo en `workspace.ts` (`requestTypes()`).

## 3. Frontend — módulo de UI

1. Crear `frontend/src/scripts/modules/reports.ts` con una factory que recibe sus
   dependencias por **inyección** y trabaja únicamente con el contexto recibido:

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
`repaint` para re-renderizar. Así Inicio conserva la responsabilidad de composición y
la sección mantiene una sola responsabilidad. En backend sigue siendo un dominio normal
(`services/datalake.py`, `repositories/datalake.py`, `modules/datalake_routes.py`).

## 4. Validar y publicar

- **Siempre** correr `npm run check` antes de publicar: compila frontend y Python,
  verifica el estándar de acceso a datos (paginación DynamoDB) y sintetiza el CDK.
- Backend: publicar el código Lambda según `docs/17_desarrollo_local_publicacion.md`
  (con el aviso de despliegue a usuarios: `scripts/deploy-flag.sh start|done`); validar
  por API. Ejecutar `npm run infra:deploy` cuando el módulo agregue infraestructura,
  variables o permisos.
- Frontend: `pnpm build` (Vite falla ante imports no resueltos) **y prueba en navegador**
  (con `@ts-nocheck`, una referencia global no definida solo falla en runtime). Publicar
  según `docs/17_desarrollo_local_publicacion.md`.

## Resumen de los puntos de extensión

| Pieza | Archivo | Integración |
| --- | --- | --- |
| Clave del módulo | `backend/app/modules/manifest.py` | Registro en la fuente única |
| Servicio | `backend/app/services/<x>.py` | Archivo nuevo por dominio |
| Repositorio | `backend/app/repositories/<x>.py` | Archivo nuevo por dominio |
| Rutas backend | `backend/app/modules/<x>_routes.py` | Archivo autodescubierto |
| API Gateway | `infra/lib/gestion-proyectos-stack.ts` | Proxy existente; cambia solo ante infraestructura o permisos nuevos |
| Módulo frontend | `frontend/src/scripts/modules/<x>.ts` | Factory nueva por dominio |
| Wiring frontend | `frontend/src/scripts/app.ts` | Importación, instancia y delegación |

Referencias: `docs/05_api_backend.md` (estructura backend), `docs/18_servicios_y_runtime.md`
(runtime), `docs/01_arquitectura_aws.md` (capas).
