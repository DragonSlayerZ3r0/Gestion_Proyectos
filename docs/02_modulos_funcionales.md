# Módulos funcionales

## Principio de menú dinámico

Cada usuario solo ve los módulos que tiene habilitados. Ocultar un módulo en frontend mejora la experiencia, pero no reemplaza la validación obligatoria de permisos en Lambda.

## Inicio

Pantalla principal con resumen de proyectos, tareas asignadas, accesos disponibles y actividad relevante.

### Estado implementado

Dashboard organizado en **pestañas** (`renderHome` en `frontend/src/scripts/modules/home.ts`, Chart.js cargado bajo demanda desde CDN). Cada pestaña es un bloque independiente:

1. **Resumen** (pestaña `resumen`): totales de proyectos, tareas y personas; dona de tareas por estado y barra de proyectos por estado. Endpoint `GET /api/home/summary` (módulo `home`).
2. **Data Lake** (pestaña `datalake`): cantidad de bases, tablas y tamaño total del data lake (de las stats cacheadas por el sync), más las bases más grandes; **y el Monitoreo de cargas** (ver abajo).
3. **Facturación** (pestaña `facturacion`, **solo rol `admin`**): selector de **cuenta** (186281981036 app / 396913696127 hub) y de **periodo**; tarjetas de Uso/Créditos/Soporte/Impuestos/Neto, barra de costo por servicio (top 10), línea de **tendencia diaria que respeta el toggle Neto/Bruto** (`daily`/`dailyGross`; en cuentas donde los créditos cubren el consumo el neto diario es ~0 → línea plana, por eso en "Bruto" se ve el consumo real — ambas series salen de **una sola** llamada CE agrupada por `RECORD_TYPE`) y créditos por servicio. Endpoint `GET /api/home/costs?account=&start=&end=` (`HomeService`, `backend/app/services/home.py`). Los costos se cargan solo al abrir la pestaña (lazy).

**Visibilidad de pestañas por usuario**: Resumen y Data Lake son permisos granulares asignables desde Administración (claves `home_resumen` y `home_datalake`, manifiesto `backend/app/modules/manifest.py → HOME_TABS`). Se guardan como filas `MODULE#` igual que los módulos, pero se exponen aparte en `GET /api/me` como `homeTabs` (no son entradas de menú). Facturación **no** es asignable: es exclusiva de administradores y se controla por rol tanto en el frontend como en el backend (`/api/home/costs` exige `admin`). Usuarios previos a esta función (sin filas de pestaña) ven todas las pestañas no sensibles por defecto.

### Monitoreo de cargas (pestaña Data Lake)

Monitorea cuántos **archivos** y cuánto **peso** se cargaron por día en las zonas del data lake (p. ej. `arc-enterprise-data/stage/landing` y `.../stage/staging`), por zona y por área.

- **Colector intercambiable (Fase 1: listado S3)**: `backend/app/services/datalake.py` lista los prefijos configurados en `INGEST_TARGETS` por área en paralelo (`ThreadPoolExecutor`) y agrupa los objetos por **fecha de `LastModified`** (UTC) → `{archivos, bytes}` por día. Diseñado para reemplazarse por **S3 Inventory + lectura del manifiesto** en Fase 2 (escala de millones) **sin tocar UI ni modelo** — solo cambia el colector. Limitación: agrupa por fecha de carga real (no por la fecha lógica del nombre del archivo); reprocesos cuentan en el día del reproceso.
- **Escaneo asíncrono**: como listar S3 es lento, el escaneo corre por **auto-invocación** de la Lambda (`InvocationType=Event`, `action=datalake_ingest_scan`), igual que el sync del catálogo; no bloquea la API ni topa el límite de 29 s. El frontend hace **polling** mientras `scanning`.
- **Caché + TTL + botón** (mecánica tipo Facturación): histograma cacheado en DynamoDB (`DATALAKE#INGEST`), **TTL 12 h** (al abrir la pestaña, si está vencido se dispara un escaneo en segundo plano), más botón **"Escanear ahora"** para forzar. Detalle por área en items aparte (`<bucket>#detail#<zona>`).
- **Endpoints** (módulo `home`): `GET /api/datalake/buckets`, `GET /api/datalake/ingest?bucket=` (overview, auto-dispara si vencido), `POST /api/datalake/ingest/scan?bucket=` (forzar), `GET /api/datalake/ingest/detail?bucket=&zone=` (por área).
- **Rango de fechas** (filtro de visualización, **sin re-escanear** ni costo extra: opera sobre el histograma ya cacheado): presets **Todo / 30 días / 90 días / Este año** + **Desde/Hasta** personalizado (default 90 días). Filtra gráfico, listas y totales. Con un rango activo, los totales por área se recalculan del detalle (`byArea→byDay`) sumando los días del rango. (El escaneo siempre lista todo; el rango es solo presentación.)
- **Frontend**: sub-módulo `frontend/src/scripts/modules/datalake.ts` (`createDatalakeModule(ctx)`), compuesto por el módulo Inicio que le delega render/eventos/gráfico de la sección. Toggle zona/métrica, gráfico de barras diario, y dos vistas conmutables:
  - **Por área**: cada área → drill a **tabla diaria ordenable** (Día / Archivos / Peso).
  - **Por fecha** (para investigar picos): cada día → drill a las **áreas ingestadas ese día** (pivote del detalle por área, sin nuevas llamadas), tabla ordenable por Día/Archivos/Peso. Además **clic en una barra del gráfico** salta a esa fecha y abre su desglose.
- **Alcance inicial**: `arc-enterprise-data` (landing/staging). Agregar buckets/zonas = una entrada en `INGEST_TARGETS` (requiere además permiso `s3:ListBucket` sobre el bucket, ya presente para los buckets del data lake).

**Cuentas del selector (config-driven, fuente única)**: la lista de cuentas vive en **un solo lugar**: la constante `costAccounts` del stack CDK (`infra/lib/gestion-proyectos-stack.ts`). De ahí se derivan automáticamente: (a) la env var `COST_ACCOUNTS` que lee el backend para la **whitelist** y el **routing** (`HomeService._load_cost_accounts` / `_ce_client`), (b) los permisos `sts:AssumeRole` del rol de la Lambda, y (c) el **selector del frontend**, que se arma desde `GET /api/home/cost-accounts` (admin-only) y muestra cada cuenta como `nombre (id)`. Cada entrada tiene `mode`: `direct` (Cost Explorer de la propia cuenta de la Lambda) o `assume` (otra cuenta vía `sts:AssumeRole` a `roleArn`).

**Cómo agregar una cuenta nueva al dashboard de costos**:
1. **Crear el rol de lectura en la cuenta nueva** (una sola vez): ejecutar `scripts/grant-hub-cost-explorer.sh` con un perfil **admin de esa cuenta**. El script crea el rol `gestion-proyectos-cost-reader` con `ce:Get*` y una *trust policy* que confía en el rol de la Lambda de la app (`gestion-proyectos-dev-api-role`). Ejemplo: `AWS_PROFILE=<perfil-admin-cuenta-nueva> ./scripts/grant-hub-cost-explorer.sh`.
2. (Opcional) **Obtener el nombre legible** de la cuenta: `aws ce get-dimension-values --dimension LINKED_ACCOUNT --time-period Start=AAAA-MM-01,End=AAAA-MM-01 --profile <perfil-de-esa-cuenta>` (campo `description`).
3. **Agregar una entrada** en `costAccounts` (CDK): `{ id: "<id>", name: "<nombre>", mode: "assume", roleArn: "arn:aws:iam::<id>:role/gestion-proyectos-cost-reader" }`.
4. **`cdk deploy`**. No hay que tocar código del backend ni del frontend: la whitelist, el routing, el permiso AssumeRole y el selector se actualizan solos.

> Nota: el `roleArn` siempre requiere permiso explícito por seguridad (no es automático leer la facturación de otra cuenta). Si la cuenta nueva fuera la propia de la Lambda, usar `mode: "direct"` sin `roleArn`.

**Acceso a costos (Cost Explorer)**:
- Cuenta app (186281981036): el rol de la Lambda tiene `ce:GetCostAndUsage` directo (`mode: direct`).
- Cuenta hub (396913696127): la Lambda hace `sts:AssumeRole` al rol `gestion-proyectos-cost-reader` del hub (creado por `scripts/grant-hub-cost-explorer.sh`), que tiene `ce:Get*` (`mode: assume`). Cada cuenta tiene su Cost Explorer independiente (el hub no es la pagadora de la app).
- Las consultas a CE cuestan ~$0.01 por solicitud (cada carga del bloque hace 4 → ~$0.04), así que el resultado se cachea en DynamoDB (`HOME#COSTS`, clave `cuenta#inicio#fin`).
- **TTL diferenciado** (`_ttl_for_period`): los **meses cerrados** (su fecha fin ya pasó) no cambian → caché **30 días**; el **mes en curso** → caché **8 h**, alineado con que AWS solo refresca Cost Explorer ~3 veces al día. Así los meses históricos se consultan una sola vez y el mes actual no se re-consulta sin necesidad.
- La llamada a CE es **bajo demanda** (al abrir el bloque o cambiar cuenta/periodo), nunca en segundo plano. El item guarda `fetchedAt`; el dashboard muestra la fecha/hora absoluta de actualización para que los admin no refresquen por gusto.
- Botón **"Actualizar ahora"** (`?force=1`): salta el caché y vuelve a consultar AWS, con confirmación que advierte el costo. Útil cuando se necesita el dato más reciente del mes en curso.
- **Detalle por servicio** (`GET /api/home/costs/detail?account=&service=&start=&end=`, admin-only): bajo el gráfico de costo por servicio, cada servicio tiene un **ícono discreto (▸) a la izquierda** que expande inline el **desglose por tipo de uso** (`USAGE_TYPE`) — el "qué exactamente" se consume (p. ej. SageMaker → Studio, training por tipo de instancia). Muestra **costo y cantidad con su unidad** (p. ej. `210,185,825 Requests`, `86.99 Hrs`), en tabla **ordenable** por Tipo de uso / Cantidad / Costo. Es **carga diferida**: solo se consulta al abrir el detalle, así los costos por tema cargan rápido y el detalle no bloquea. Es consumo bruto (excluye créditos/reembolsos), top 25 por costo. Tiene su propia entrada de caché en `HOME#COSTS` (SK `cuenta#inicio#fin#svc#servicio`) con el mismo TTL diferenciado. La lista de cuentas del selector se carga **en paralelo**, sin bloquear los costos.
- **Detalle diario / detección de picos** (`GET /api/home/costs/daily?account=&start=&end=`, admin-only): sección **"Detalle diario"** como **tabla ordenable** con columnas **Diario** (fecha) · **Gasto del día** (total) · **Variación diaria** (Δ vs día anterior, con color: ámbar sube, verde baja); clic en cualquier encabezado ordena asc/desc. El backend devuelve costo por día y servicio (consumo bruto, `DAILY` + `GroupBy SERVICE`, **1 sola** llamada a CE para todo el mes); el frontend calcula el Δ día contra día, resalta el día de mayor aumento con un *callout* que nombra el **servicio causante**, y lista los días **ordenados por fecha (la última primero)**, **incluido el día 1** (su variación es $0.00 al no tener día previo). Al expandir un día se ven los servicios (los que subieron con su Δ; el día 1 muestra el gasto por servicio) y, desde ahí, el **tipo de uso de ESE día** (reusa el endpoint de detalle con ventana de un día → SK de caché `cuenta#día#día+1#svc#servicio`). Caché propia `cuenta#inicio#fin#daily-svc` con el mismo TTL diferenciado.
  - **Auto-mostrar desde caché**: al abrir Facturación se hace una lectura **solo-caché** (`?cachedOnly=1`): si el análisis ya está calculado, se muestra **automáticamente y sin costo** (lectura DynamoDB), incluyendo la **fecha de cálculo** (`Calculado: … (hace X, desde caché)`, reusa `fetchedAt`/`cached` igual que Facturación). Si no hay caché, aparece el botón **"Analizar picos"** (ahí sí se gasta la consulta CE). Botón **"Recalcular"** (`?force=1`) cuando ya está cargado. Así no hay que presionar el botón cuando ya está cacheado.
- **Títulos de sección colapsables**: "Detalle diario", "Detalle por servicio" y "Créditos por servicio" tienen el título clicable (caret) que contrae/expande su listado; cada uno guarda su estado por separado.
- Todas las cifras viajan como string (DynamoDB no acepta float).

## Proyectos y tareas

Módulo operativo principal para crear, editar, consultar y administrar proyectos, tareas y personas asignadas desde una sola pantalla.

Aunque los permisos técnicos puedan existir como `projects` y `tasks`, el frontend debe presentarlos como una sola entrada: `Proyectos y tareas`. No se debe obligar al usuario a cambiar de ventana para crear o revisar tareas del proyecto activo.

Debe permitir responsables, estado, descripción, usuarios asociados, tareas por proyecto, prioridades, fechas, comentarios, movimiento Kanban simple y relación con tablas del Data Lake cuando aplique.

## Catálogo Data Lake

Módulo para explorar bases, tablas y columnas permitidas. Debe combinar metadata técnica de Glue Catalog con contexto funcional guardado en DynamoDB.

## Tableros

Módulo futuro para vistas resumidas, indicadores y paneles internos.

## Solicitudes

Módulo futuro para solicitudes de acceso, cambios, revisiones o trabajo asociado a proyectos y datos.

## Administración

Módulo para usuarios con permisos administrativos. Inicialmente gestiona accesos globales, módulos por usuario, activación funcional y auditoría.
