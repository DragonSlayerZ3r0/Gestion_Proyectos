# Arquitectura AWS

## Arquitectura base

→ **[Abrir guía visual de arquitectura y runtime](Guia%2002%20-%20Arquitectura%20y%20runtime.canvas)**

La guía muestra el flujo entre usuario, frontend, identidad, API, Lambda y datos;
también separa los recursos de la cuenta de aplicación y los servicios de la cuenta hub.

La plataforma utiliza un patrón serverless por capas, con **módulos enchufables**
tanto en backend como en frontend:

- Capa de presentación: Astro en `frontend/`. El shell vive en `scripts/app.ts`; los
  módulos de UI `home`, `workspace`, `catalog`, `admin` y el submódulo `datalake`
  viven en `scripts/modules/` y reciben dependencias mediante `createXModule(ctx)`.
- Capa de entrada HTTP: API Gateway y `backend/app/handler.py` (delgado) + `core/router.py`
  (router por registro). Cada módulo declara sus rutas en `modules/<x>_routes.py` y se
  autodescubre; los módulos se incorporan mediante puntos de extensión estables.
- Capa de identidad: Cognito, JWT Authorizer y `backend/app/auth.py`. Autorización
  declarativa en `core/guards.py` (`ensure_module_access`, `ensure_admin`).
- Capa funcional: servicios en `backend/app/services/`.
- Capa de datos: **un repositorio por dominio** en `backend/app/repositories/`
  (`users`, `workspace`, `catalog`, `home`, `datalake`, `athena_monitor`, `glue`)
  sobre una base común en `base.py`.
- Capa de infraestructura: CDK TypeScript en `infra/`.

El detalle operativo de puertos, desarrollo local y publicación está en `docs/17_desarrollo_local_publicacion.md`.

## Stack tecnológico

Lenguajes, frameworks y herramientas concretas por capa:

| Capa | Lenguaje | Framework / herramientas | Librerías clave | Dónde |
| --- | --- | --- | --- | --- |
| Frontend (UI) | **TypeScript** | **Astro** genera HTML y JavaScript estático. La UI imperativa se organiza como shell y módulos por inyección de dependencias (`createXModule(ctx)`). | AWS SDK v3 (`@aws-sdk/client-cognito-identity-provider`), Chart.js (dashboard), D3 (grafo del catálogo) | `frontend/` |
| Estilos | **CSS** plano | Hoja global organizada por áreas funcionales y responsive | — | `frontend/src/styles/app.css` |
| Backend (API) | **Python 3.12** | Router propio por registro (`core/router.py`) y módulos de rutas autodescubiertos | `boto3` (AWS SDK) | `backend/app/` |
| Persistencia | — | **DynamoDB single-table** con repositorios por dominio | Acceso directo mediante `boto3` resource | `backend/app/repositories/` |
| Infraestructura | **TypeScript** | **AWS CDK v2** (`aws-cdk-lib`) | — | `infra/` |
| Build / tooling | — | **pnpm** (workspace), **Vite/esbuild** (vía Astro) | — | raíz · `frontend/` |

## Modelo de ejecución

- El frontend mantiene el estado en `state`, cambia `state.activeModule` para navegar y vuelve a renderizar el módulo activo.
- El backend resuelve rutas mediante `core/router.py`, aplica autorización declarativa en `core/guards.py` y persiste mediante repositorios `boto3`.
- Las operaciones Athena se definen en servicios backend y devuelven resultados acotados al frontend.

## Servicios utilizados

- Astro: frontend web.
- S3 privado: almacenamiento del build estático.
- CloudFront: distribución del frontend.
- Cognito: autenticación.
- API Gateway: entrada HTTP segura para backend.
- Lambda Python: lógica de negocio.
- DynamoDB: datos operativos, autorización funcional y contexto.
- Glue Catalog: metadata técnica de bases, tablas y columnas.
- Athena: preview y consultas controladas.
- S3 Data Lake: datos fuente.
- CloudWatch: logs y métricas.
- IAM: permisos entre servicios.
- Lake Formation: control adicional opcional sobre datos.

## Flujo frontend a backend

1. El usuario abre la aplicación desde CloudFront.
2. El frontend valida sesión con Cognito.
3. El frontend envía el JWT en cada llamada a API Gateway.
4. API Gateway valida el token con JWT Authorizer.
5. Lambda recibe identidad validada.
6. Lambda consulta DynamoDB para permisos funcionales.
7. Lambda ejecuta la acción permitida y devuelve respuesta estándar.

## Flujo de inicio de sesión

1. El usuario inicia sesión con Cognito.
2. Cognito emite tokens.
3. El frontend conserva la sesión según la estrategia definida.
4. El frontend llama `GET /api/me`.
5. Backend devuelve perfil funcional, módulos habilitados y permisos.

## Flujo API

Todas las operaciones pasan por API Gateway y Lambda. El frontend accede a DynamoDB, Glue, Athena y S3 Data Lake exclusivamente mediante servicios backend autorizados.

## Flujo local a publicación

1. Desarrollar frontend con Astro en `http://127.0.0.1:4321/`.
2. Validar frontend, Python y CDK con `npm run check`.
3. Publicar cambios de backend con zip de `backend/app` hacia Lambda cuando solo cambia código Python.
4. Publicar frontend con `npm run build -w frontend`, `aws s3 sync` e invalidación CloudFront.
5. Usar `npm run infra:deploy` cuando cambien recursos AWS o configuración estructural.

## Flujo consulta Data Lake

1. Frontend solicita catálogo o preview.
2. Lambda valida permisos funcionales en DynamoDB.
3. Lambda obtiene metadata técnica desde Glue Catalog.
4. Lambda combina metadata técnica con contexto funcional guardado en DynamoDB.
5. Para preview, Lambda ejecuta consulta Athena controlada.
6. Lambda devuelve datos limitados y seguros.

## Ambientes

- `dev`: desarrollo y pruebas locales.
- `test`: validación integrada.
- `prod`: uso real.

Cada ambiente debe tener recursos, variables y permisos separados.
