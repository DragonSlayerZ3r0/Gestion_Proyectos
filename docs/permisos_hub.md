# Permisos cross-account: hub (396913696127) + rol app

Lo que el **administrador del hub** debe otorgar para que la app (cuenta
`186281981036`) funcione contra los datos/servicios del hub, **más** el estado real
del rol de la app y la **drift/config residual** detectada. La app NO puede aplicar
lo del hub sola: requiere un admin del hub (usuario/rol IAM `admin_dl`, perfil CLI
`perfil_admin_dl`).

> **Verificado contra el hub en vivo el 2026-06-26** (perfil `perfil_admin_dl`).
> Este documento refleja lo realmente aplicado, no un diseño teórico.

> Al **crear prod** o cambiar el rol de la Lambda, hay que **repetir TODO esto**
> apuntando al ARN del rol de prod (los grants están atados al ARN). Ver
> [19_paso_a_produccion.md](19_paso_a_produccion.md).

Rol de la Lambda de la app (el principal que recibe los permisos):
`arn:aws:iam::186281981036:role/gestion-proyectos-dev-api-role` (prod: el rol pre-creado).

## ¿Dónde se aplica cada permiso? (vista rápida)

Cada permiso se otorga en **una de las dos cuentas**. Los del **hub** los aplica el
admin del hub; los de la **app** los crea el CDK al desplegar.

| Permiso / recurso | Cuenta (lado) | Dónde exactamente | Cómo se aplica |
| --- | --- | --- | --- |
| Trust para asumir el rol del hub | **Hub** 396913696127 | trust policy del rol `gestion-proyectos-cost-reader` | script `grant-hub-cost-explorer.sh` |
| Cost Explorer + `cloudtrail:LookupEvents` | **Hub** | inline `CostExplorerReadOnly` del rol `cost-reader` | script `grant-hub-cost-explorer.sh` |
| Athena + Glue + `lakeformation:GetDataAccess` + S3 (datos `arc-ingestioncontrol` + resultados `arc-athena-query-resultsdata`) | **Hub** | inline `AthenaIngestionControl` del rol `cost-reader` | **a mano** (sin script — Mec. 1c) |
| `SELECT`/`DESCRIBE` sobre la tabla de control | **Hub** (Lake Formation) | grant LF al rol `cost-reader` | **a mano** (comando — Mec. 3) |
| Listar S3 del lake (histograma), lado dueño del bucket | **Hub** | bucket policy de cada bucket (`arc-ingestioncontrol`, `arc-enterprise-data`, …) | script `grant-datalake-s3.sh` / a mano (Mec. 2) |
| Identidad de la Lambda: logs, Glue read, `s3:ListBucket` lake, CE, CloudTrail, `sts:AssumeRole`→`cost-reader`, DynamoDB RW | **App** 186281981036 | inline CDK `ApiFunctionRoleDefaultPolicy…` del rol app | **CDK** (automático en deploy) |

**Regla simple:** todo lo que toca **datos/servicios del hub** se otorga **en el
hub** (sobre el rol `cost-reader` o las bucket policies / Lake Formation). Todo lo
que es la **identidad y permisos propios de la Lambda** se otorga **en la app**
(vía CDK). Lo único que une ambos lados es el `sts:AssumeRole` (la app pide asumir;
el hub permite ser asumido).

> Las 2 inline manuales del rol app y el rol gemelo del hub **NO son necesarios**
> (ver "Limpieza recomendada"). No forman parte de lo que hay que otorgar.

Detalle de los **tres mecanismos del hub** abajo.

---

## Mecanismo 1 — Rol cross-account `gestion-proyectos-cost-reader` (AssumeRole)

Rol en el hub que la Lambda **asume** (`sts:AssumeRole`). Lo usan costos, el panel
de Responsables, los **registros del data lake** (Athena) y el **monitoreo de
consumo de Athena**. Estado real: **trust** que permite asumirlo solo al rol de la
Lambda de la app, **sin** políticas administradas, y **dos** políticas inline.

### 1a. Trust policy
Permite `sts:AssumeRole` únicamente a `arn:aws:iam::186281981036:role/gestion-proyectos-dev-api-role`.
Se aplica con `scripts/grant-hub-cost-explorer.sh` (idempotente).

### 1b. Inline `CostExplorerReadOnly` — costos + responsables
Aplicada por `scripts/grant-hub-cost-explorer.sh`. Contenido real (Resource `*`):
`ce:GetCostAndUsage`, `ce:GetCostForecast`, `ce:GetDimensionValues`, `cloudtrail:LookupEvents`.

> Este script sirve también para **cuentas de costo nuevas** (solo costos). El hub
> necesita ADEMÁS la inline 1c (que NO está en ningún script).

### 1c. Inline `AthenaIngestionControl` — registros + monitoreo de Athena
**Aplicada a mano (no hay script).** Contenido real (5 sentencias):

| Sid | Acciones | Resource |
| --- | --- | --- |
| `Athena` | `athena:StartQueryExecution`, `GetQueryExecution`, `GetQueryResults`, `StopQueryExecution`, `GetWorkGroup`, `BatchGetQueryExecution`, `ListQueryExecutions` | `*` |
| `GlueRead` | `glue:GetTable`, `GetDatabase`, `GetPartitions`, `GetPartition` | `catalog`, `database/stage_staging`, `table/stage_staging/ctl_ingestion_unstructured` (todo en `396913696127`) |
| `LakeFormation` | `lakeformation:GetDataAccess` | `*` |
| `S3ControlRead` | `s3:GetObject`, `s3:ListBucket`, `s3:GetBucketLocation` | `arc-ingestioncontrol` (+ `/*`) — datos de la tabla de control |
| `S3AthenaResults` | `s3:GetObject`, `s3:PutObject`, `s3:ListBucket`, `s3:GetBucketLocation` | `arc-athena-query-resultsdata` (+ `/*`) — resultados de Athena |

Datos clave (constantes del código en `backend/app/services/datalake.py`,
`athena_monitor.py`): workgroup `primary` (su *OutputLocation* real es
`s3://arc-athena-query-resultsdata/rendicion_cuentas/`), base `stage_staging`,
tabla `ctl_ingestion_unstructured`.

---

## Mecanismo 2 — Bucket policies en los buckets del data lake

Para el **histograma de cargas** (Archivos/Peso) la app lista S3 con su **propio
rol** (NO asume el rol del hub), así que los buckets del hub deben permitirlo en
su *bucket policy*. Estado real verificado:

- **`arc-ingestioncontrol`**: sentencia dedicada `Sid=GestionProyectosAppRead`,
  Principal = rol de la app, acciones `s3:GetObject`, `s3:ListBucket`. (Coincide
  con el patrón del script `grant-datalake-s3.sh`.)
- **`arc-enterprise-data`**: el rol de la app está **añadido a una condición
  `aws:PrincipalArn` compartida** (Principal `*` + `StringEquals aws:PrincipalArn`
  con una lista que incluye `admin_dl`, `arc_curizar` y el rol de la app), con
  acciones `s3:GetObject/PutObject/DeleteObject/ListBucket`. **OJO: esto NO lo
  hizo el script** (`grant-datalake-s3.sh` crea un `Sid` dedicado de solo lectura);
  aquí lo agregaron a mano a una sentencia existente. Para prod, decidir si se
  replica el patrón compartido o se usa el `Sid` dedicado del script.

Lado app (ya en el CDK): política de identidad `DataLakeS3ReadOnly`
(`s3:ListBucket`, `s3:GetBucketLocation`) sobre `DATA_LAKE_BUCKETS`.

---

## Mecanismo 3 — Lake Formation (grant sobre la tabla de control)

La tabla `stage_staging.ctl_ingestion_unstructured` está gobernada por LF.
Estado real verificado: el rol `gestion-proyectos-cost-reader` tiene **`SELECT`**
y **`DESCRIBE`** sobre la tabla. Comando para reproducirlo:

```bash
aws lakeformation grant-permissions \
  --principal DataLakePrincipalIdentifier=arn:aws:iam::396913696127:role/gestion-proyectos-cost-reader \
  --resource '{"Table":{"CatalogId":"396913696127","DatabaseName":"stage_staging","Name":"ctl_ingestion_unstructured"}}' \
  --permissions SELECT DESCRIBE
```

Sin este grant, Athena devuelve "Insufficient Lake Formation permission(s)".

---

## Lado app (cuenta 186281981036) — rol `gestion-proyectos-dev-api-role`

Verificado en vivo 2026-06-26. Es el rol de ejecución de la Lambda
`gestion-proyectos-dev-api`, **creado por CDK**. Tiene **3 políticas inline** y
ninguna administrada:

1. **`ApiFunctionRoleDefaultPolicyF7D07E66`** — la del CDK (se recrea sola en cada
   deploy). Contiene: `logs:*` (create/put), `glue` read, `lambda:InvokeFunction`
   (a sí misma), `s3:ListBucket`+`s3:GetBucketLocation` sobre `DATA_LAKE_BUCKETS`,
   `ce:*` (incl. `GetTags`, `ListCostAllocationTags`), `cloudtrail:LookupEvents`,
   `sts:AssumeRole` → `gestion-proyectos-cost-reader`, y **DynamoDB RW** (incl.
   `BatchGetItem`) sobre `gestion-proyectos-dev-main`. *(El `BatchGetItem` confirma
   que la búsqueda por contexto del catálogo funciona en dev.)*
2. **`gestion-proyectos-dev-api-role`** (inline, **MANUAL / drift**): `cloudtrail:*`
   sobre `*`. **Redundante**: el CDK ya otorga `cloudtrail:LookupEvents` (lo único
   que se usa). Probable residuo de depuración del panel de Responsables.
3. **`s3-cross-account`** (inline, **MANUAL / drift**): `sts:AssumeRole` →
   `arn:aws:iam::396913696127:role/gestion-proyectos-dev-api-role` (un **rol gemelo
   en el hub**, mismo nombre). **El código NO asume ese rol** (usa
   `gestion-proyectos-cost-reader`) → es config muerta.

## Limpieza recomendada (residual detectado 2026-06-26)

Nada de esto rompe hoy, pero conviene depurarlo y **NO arrastrarlo a prod**:

- **Rol gemelo en el hub `gestion-proyectos-dev-api-role`**: experimental, NO usado
  por el código. Tiene permisos amplios y de escritura (`s3:GetObject/PutObject`
  sobre `arc-enterprise-data/*`, `sagemaker:*`, `datazone:*`, `cloudtrail:*`).
  Candidato a **eliminar** (es el único con escritura sobre el data lake).
- **Inline manual `gestion-proyectos-dev-api-role`** en el rol app: reducir
  `cloudtrail:*` → nada (el CDK ya da `LookupEvents`) o eliminar la política.
- **Inline manual `s3-cross-account`** en el rol app: eliminar (apunta al rol
  gemelo no usado).
- **Prod**: el rol pre-creado debe tener SOLO lo del CDK (equivalente a
  `ApiFunctionRoleDefaultPolicy`) + lo de este documento; no copiar la drift.

## Resumen por feature

| Feature | Mecanismo(s) en el hub |
| --- | --- |
| Costos cross-account (Facturación) | 1a + 1b (`ce:*`) |
| Responsables (CloudTrail) | 1a + 1b (`cloudtrail:LookupEvents`) |
| Registros del data lake (Athena) | 1a + **1c** + **3** (LF) |
| Monitoreo consumo de Athena | 1a + 1c (`cloudtrail:LookupEvents`, `athena:Batch/List/Get…`) |
| Histograma de cargas (Archivos/Peso) | **2** (bucket policy al rol de la app) |

## Deuda de reproducibilidad (para prod)
- La inline **1c** (`AthenaIngestionControl`) y el grant **3** (Lake Formation) se
  aplicaron **a mano** — convendría un script `grant-hub-datalake.sh` (ya se
  conocen todos los valores exactos: ver tabla 1c). 
- El acceso a **`arc-enterprise-data`** se hizo por condición compartida, no por el
  script; documentar/decidir el patrón para prod.
