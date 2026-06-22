# Servicios AWS en contexto y comportamiento en runtime

Documento para personal desarrollador. Complementa `docs/01_arquitectura_aws.md` (arquitectura) y `docs/10_integraciones_aws.md` (permisos IAM): aquí se explica **qué hace cada servicio en este proyecto concreto, dónde vive en el código y cómo se comporta el sistema en runtime**, incluyendo detalles que no son obvios leyendo el código.

## Mapa: servicio AWS → código → configuración

| Servicio | Papel en este proyecto | Dónde vive en el código | Recurso real en AWS (`dev`) | Configuración | Si falla / falta |
| --- | --- | --- | --- | --- | --- |
|  CloudFront + S3 privado | Sirve el build estático de Astro. S3 nunca es público; CloudFront usa OAC. | `infra/lib/gestion-proyectos-stack.ts` | Bucket `gestion-proyectos-dev-frontend-186281981036` (raíz: `index.html`, `config.json`, `_astro/`) · Distribución CloudFront `E2K3CA110228B1` → `https://d269paz1z7q1g0.cloudfront.net/` | Invalidación tras cada publicación | Usuario ve versión vieja (caché) o error 403  |
|  Cognito | Solo autenticación (identidad). Nunca autorización. | Frontend: `index.astro` (SDK `@aws-sdk/client-cognito-identity-provider`, flujo `USER_PASSWORD_AUTH`). Backend: validación JWT | User Pool `us-east-1_lN4JYAVlQ` · App Client `uhquk1hakj8nifgi3j6hv8dbh` | `config.json`: `region`, `cognitoUserPoolId`, `cognitoClientId` | Login muestra "configuración de acceso no disponible"  |
|  API Gateway (HTTP API) | Única puerta al backend. Valida el JWT de Cognito con JWT Authorizer antes de invocar Lambda. | `infra/` define rutas y authorizer | `https://63ibnl13da.execute-api.us-east-1.amazonaws.com/` | `config.json`: `apiBaseUrl` | Toda la app queda en solo-portada; `/api/me` falla  |
|  Lambda Python | Toda la lógica de negocio. Handler delgado que arma un **router por registro** (cada módulo registra sus rutas; autodescubrimiento con `pkgutil`). También se auto-invoca asíncronamente para el sync global del catálogo. | `backend/app/handler.py` → `core/router.py` → `modules/*_routes.py` → `services/` → `repositories/` | Función `gestion-proyectos-dev-api` | Variables de entorno en CDK (`MAIN_TABLE_NAME`, `APP_ACCOUNT_ID`, `HUB_ACCOUNT_ID`, `HUB_COST_ROLE_ARN`) | Errores 5xx; revisar CloudWatch Logs  |
|  DynamoDB (single-table) | Cuatro cosas en una tabla: (1) autorización funcional (usuarios, módulos), (2) datos operativos (personas, proyectos, tareas), (3) caché del catálogo Glue + contexto funcional, (4) caché de costos AWS (`HOME#COSTS`). | `backend/app/repositories/` (**un repo por dominio**: `users`, `workspace`, `catalog`, `home`; base común en `base.py`), modelo en `docs/04_modelo_dynamodb.md` | Tabla `gestion-proyectos-dev-main` | `MAIN_TABLE_NAME` | Sin permisos no hay módulos: usuario autenticado pero sin acceso a nada  |
|  Glue Catalog | Fuente de metadata técnica del Data Lake (bases, tablas, columnas, tipos, particiones). Solo lectura. **El frontend nunca lee Glue en línea**: lee la caché en DynamoDB poblada por sync. | `backend/app/repositories/glue.py`, `backend/app/services/catalog.py` | Catálogo de la cuenta `186281981036` (bases locales) | `GLUE_CATALOG_ID` opcional | Catálogo muestra "Sin datos. Sincroniza para importar"  |
|  Athena | Previews y consultas controladas (límite de filas, sin SQL libre). Aún no expuesto en frontend. | Planificado; ver `docs/07_catalogo_datalake.md` | — | `ATHENA_WORKGROUP`, `ATHENA_OUTPUT_LOCATION` | n/a todavía  |
|  Lake Formation | Pendiente: hoy la Lambda solo ve bases locales en modo `IAM_ALLOWED_PRINCIPALS`. Ver "Visibilidad pendiente" en `docs/07_catalogo_datalake.md` | — | — | — | Bases del hub (`396913696127`) no aparecen  |
|  CloudWatch | Logs de la Lambda (única forma de depurar backend; no hay servidor local de backend). | Automático | Log group `/aws/lambda/gestion-proyectos-dev-api` (retención 30 días) | — | —  |
|  CDK (CloudFormation) | Toda la infraestructura como código, stack único, ambiente `dev`, cuenta `186281981036`. | `infra/lib/gestion-proyectos-stack.ts` | Stack `GestionProyectosDevStack` | Perfil SSO `gestion-proyectos-dev` | `npm run infra:deploy` falla si la sesión SSO expiró  |

Contenido esperado del bucket frontend: `index.html` (la página única de Astro), `_astro/` (JS/CSS con hash del build), `icono_gp.png` y `config.json`. Este último **no proviene del build**: se sube por separado con los valores runtime del ambiente, y por eso la publicación sincroniza con `--exclude config.json` (un deploy de frontend nunca debe pisarlo). Archivos como `.DS_Store` son basura de macOS subida por accidente; pueden eliminarse.

Regla transversal: **el frontend jamás habla directo con DynamoDB, Glue, Athena ni S3 Data Lake**. Todo pasa por API Gateway + Lambda, donde se valida el permiso funcional en DynamoDB. Ocultar un botón en frontend no es seguridad.

## Cadena de identidad y autorización (de punta a punta)

```text
Usuario → Cognito (¿quién es?) → JWT
JWT → API Gateway JWT Authorizer (¿token válido?)
Lambda → DynamoDB (¿qué módulos/acciones tiene habilitados?)
Lambda → ejecuta y responde { ok, data | error }
Frontend → GET /api/me → pinta solo los módulos habilitados
```

Cognito identifica; DynamoDB autoriza; Lambda aplica. Son tres responsabilidades separadas a propósito: crear un usuario en Cognito **no** le da acceso a nada hasta que exista su perfil funcional en DynamoDB (el seed de CDK crea el usuario inicial con sus módulos).

## Comportamiento en runtime (lo que no es obvio en el código)

### Sesión y expiración (~1 hora)

- Los tokens de Cognito se guardan en `sessionStorage` bajo `gestionProyectosAuth` con un `expiresAt` calculado de `ExpiresIn` (típicamente 3600 s).
- **No hay flujo de refresh token implementado.** Aunque se guarda el `refreshToken`, nunca se usa: cuando `expiresAt` vence, `getCurrentSession()` descarta la sesión y el usuario vuelve a la portada de login en la siguiente recarga, y las llamadas API empiezan a fallar con 401 en la sesión en curso.
- `sessionStorage` es por pestaña: abrir la app en otra pestaña exige login de nuevo. Cerrar la pestaña destruye la sesión. Esto es una decisión conservadora, no un bug.
- El módulo activo se persiste aparte en `gestionProyectosModule` y se restaura al recargar (si el usuario aún tiene ese módulo habilitado). Se limpia al cerrar sesión.
- Al recargar con sesión válida se ve un instante la portada de login: es el estado inicial mientras `boot()` carga `/config.json` y valida la sesión guardada. Esperado, no error.

### `config.json` es configuración runtime, no parte del build

- El frontend hace `fetch("/config.json", { cache: "no-store" })` al arrancar. Ese archivo **no** sale del build de Astro: se sube aparte a S3 (por eso el sync usa `--exclude config.json`; ver `docs/17_desarrollo_local_publicacion.md`).
- Consecuencia: se puede repuntar el frontend a otro pool/API sin recompilar. Y al revés: un deploy de frontend nunca debe pisar el `config.json` publicado.

### Catálogo: sync y caché en dos niveles

- **Nivel 1 (servidor, persistente)**: el sync copia metadata de Glue a DynamoDB. El frontend siempre lee de esta caché, nunca de Glue en línea. Claves en la tabla única: bases en `PK=CATALOG#DB / SK=<base>`, tablas en `PK=CATALOG#<base> / SK=TABLE#<tabla>`, estado del sync en `PK=CATALOG#SYNC / SK=META`.
- **El sync es diferencial** (verificado contra Glue dev): cada tabla guarda `glueUpdatedAt` (el `UpdateTime` de Glue, presente y poblado en el catálogo real) y solo se reescriben las tablas nuevas o con definición modificada; las huérfanas (ya no existen en Glue) se eliminan del caché. Semántica de `UpdateTime`: cambia con la definición (columnas, tipos, location) — que es lo que se cachea — y NO cambia al agregar particiones de datos, lo cual es correcto porque las cargas diarias no requieren re-sync. Fallback seguro: sin `UpdateTime` o sin `glueUpdatedAt` previo, se reescribe (el modo de fallo es escribir de más, nunca quedar desactualizado).
- El sync global es asíncrono: `POST /api/catalog/sync` responde de inmediato y la Lambda se auto-invoca (`InvocationType=Event`, payload `{"action": "catalog_sync_all"}`); el badge "Sincronizando en background…" refleja eso. No hay EventBridge programado todavía (pendiente acordado). Los endpoints de sync devuelven `updated` y `removed` además de `tableCount`.
- **Nivel 2 (navegador, en memoria)**: `state.catalogTableCache` guarda el detalle (columnas + contexto) de cada tabla ya consultada, clave `"db::tabla"`. Lo comparten tres consumidores: el detalle de tabla, el grafo de relaciones y la búsqueda por columna. Se pierde al recargar la página.
- La búsqueda por `Columna`/`Desc. columna` y el grafo necesitan el detalle de **todas** las tablas, así que disparan `ensureCatalogTableDetails` (precarga con 6 peticiones concurrentes). Primera vez: segundos de espera proporcionales al número de tablas; siguientes: instantáneo.

### Grafo de relaciones: heurístico, no metadata real

- Glue no expone foreign keys. Las relaciones del grafo son **heurísticas calculadas en el navegador**: FK si una columna `x_id` coincide con una tabla `x`/`xs`/`xes` de la misma base; "columna compartida" si dos tablas tienen una columna con el mismo nombre (excluyendo `id`, sufijos `_id` y nombres de ≤2 caracteres).
- Las columnas de partición (`isPartition`) se dibujan pero se excluyen de relaciones: campos como `anio`, `mes`, `dia` existen en casi todas las tablas y generarían un grafo falso totalmente conectado.
- Render en Canvas 2D por rendimiento (decisión firme: no volver a SVG por nodo). Detalle técnico completo en `docs/07_catalogo_datalake.md`.

### Frontend: SPA modular, render imperativo

- `frontend/src/pages/index.astro` es el cascarón HTML; los estilos globales en `frontend/src/styles/app.css`. `frontend/src/scripts/app.ts` es ahora el **shell** (login, navegación, dispatcher `renderModule`, estado `state` y helpers compartidos: `apiRequest`, `escapeHtml`, `formatBytes`, etc.). No hay router: "navegar" es mutar `state.activeModule` y re-renderizar.
- **Módulos por dominio** en `frontend/src/scripts/modules/`: `home.ts`, `workspace.ts`, `catalog.ts`, `admin.ts`. Cada uno exporta una factory `createXModule(ctx)` que recibe por **inyección de dependencias** el estado y los helpers compartidos. El shell crea cada módulo una vez y `renderModule` delega con `xModule.render()`. `app.ts` pasó de ~4,328 a ~700 líneas.
- Agregar un módulo de frontend = crear `modules/x.ts` con `createXModule(ctx)` y registrarlo en `renderModule` (una línea).
- Todos los archivos usan `@ts-nocheck`; el wiring se valida con `pnpm build` (Vite falla ante imports no resueltos) **y prueba en navegador** (esbuild no falla ante referencias globales no definidas → serían errores en runtime).
- Implicación al desarrollar: cualquier render reemplaza el DOM de su zona; un listener agregado a mano se pierde en el siguiente render si no se registra dentro de la función `bind*` correspondiente.
- D3 v7 se carga bajo demanda desde `unpkg.com/d3@7` al abrir el grafo (requiere salida a internet desde el navegador; no está en `package.json`).

### Backend sin servidor local

- El backend no corre localmente: se desarrolla contra la Lambda desplegada en `dev`. Cambios solo-Python se publican como zip a la Lambda; cambios de infraestructura con `npm run infra:deploy`. Depuración: CloudWatch Logs.
- Validación local disponible: `npm run check` (build de frontend + `py_compile` del backend + `cdk synth`).

## Sugerencias (deuda conocida, en orden de impacto)

1. **Implementar refresh token**: el corte de sesión a la hora es el roce operativo más visible. El `refreshToken` ya se guarda; falta el flujo `REFRESH_TOKEN_AUTH` antes de `expiresAt` y reintento ante 401.
2. **Búsqueda de columnas en backend**: hoy buscar por columna descarga el detalle de todas las tablas al navegador. Con catálogos grandes conviene un índice de columnas en DynamoDB (poblado durante el sync) y un endpoint `GET /api/catalog/search?q=`.
3. **Sync programado**: agregar regla EventBridge para `catalog_sync_all` periódico (`handler.py` ya acepta `source == "aws.events"`); hoy el sync es solo manual.
