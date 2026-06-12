# Paso a producción (cuenta AWS separada)

Manual para desplegar la plataforma en una cuenta de producción distinta de `dev` (`186281981036`). La infraestructura CDK ya está parametrizada por ambiente: todos los nombres de recursos derivan del prefijo `{appName}-{envName}`, por lo que producción se crea **desde cero y aislada** — no comparte Cognito, DynamoDB, buckets ni API con dev.

## 1. Campos a definir antes de empezar

Estos valores determinan dónde se ubicará todo. Completar esta tabla es el primer paso; el resto del manual los referencia como `<asi>`.

### Decisiones (los define el equipo)

| Campo | Descripción | Dónde se usa | Ejemplo |
| --- | --- | --- | --- |
| `<CUENTA_PROD>` | ID de la cuenta AWS de producción | Bootstrap, perfil SSO, grants Lake Formation | `999999999999` |
| `<REGION>` | Región de despliegue | Bootstrap y deploy. Hoy todo asume `us-east-1` | `us-east-1` |
| `<PERFIL_SSO_PROD>` | Nombre del perfil SSO local para la cuenta prod | `~/.aws/config`, todos los comandos `--profile` | `gestion-proyectos-prod` |
| `<ENV_NAME>` | Nombre del ambiente (contexto CDK `envName`) | Prefijo de TODOS los recursos | `prod` |
| `<APP_NAME>` | Nombre de la app (contexto CDK `appName`) | Prefijo de recursos. Mantener el default salvo razón fuerte | `gestion-proyectos` |
| `<CORREO_INICIAL>` | Correo del primer usuario funcional (contexto `initialUserEmail`) | Seed de Cognito + DynamoDB al desplegar | `admin@banrural.com.gt` |
| `<DOMINIO_PROPIO>` | (Opcional) Dominio público del frontend + certificado ACM | CloudFront alias. Si no se define, queda `*.cloudfront.net` | `gestion.banrural.com.gt` |
| `<CUENTA_HUB>` | Cuenta del data lake hub para grants Lake Formation | Permisos Glue/LF hacia el rol Lambda de prod | `396913696127` |

### Derivados (los genera CDK automáticamente a partir de los anteriores)

| Recurso | Nombre resultante con `envName=prod` |
| --- | --- |
| Stack CloudFormation | `GestionProyectos<Env>Stack` (ver ajuste 2.1: hoy está fijo en `...Dev...`) |
| Bucket frontend | `gestion-proyectos-prod-frontend-<CUENTA_PROD>` |
| Cognito User Pool | `gestion-proyectos-prod-users` (ID `us-east-1_xxxx` lo asigna AWS) |
| Cognito App Client | `gestion-proyectos-prod-web` (ID lo asigna AWS) |
| Dominio Cognito | `gestion-proyectos-prod-<CUENTA_PROD>` |
| Tabla DynamoDB | `gestion-proyectos-prod-main` |
| Lambda | `gestion-proyectos-prod-api` |
| API Gateway | `gestion-proyectos-prod-api` (URL la asigna AWS) |
| Log group | `/aws/lambda/gestion-proyectos-prod-api` |

Los IDs/URLs que asigna AWS (pool, client, API URL, distribución CloudFront) salen como **outputs del stack** al final del deploy: anotarlos en `docs/15_estado_implementacion.md` (o su equivalente prod) y usarlos para el `config.json`.

### Campos del `config.json` de producción

El frontend lee su configuración en runtime desde `/config.json` (no viaja en el build). Para prod se construye con los outputs del stack:

```json
{
  "environment": "prod",
  "region": "<REGION>",
  "apiBaseUrl": "https://<API_ID>.execute-api.<REGION>.amazonaws.com/",
  "cognitoUserPoolId": "<POOL_ID_PROD>",
  "cognitoClientId": "<CLIENT_ID_PROD>"
}
```

`apiBaseUrl` debe terminar en `/`. Este archivo se sube al bucket prod por separado y **ningún deploy de frontend debe pisarlo** (sync con `--exclude config.json`).

## 2. Ajustes de código previos (una sola vez)

Pendientes detectados; sin esto el deploy a prod chocaría con dev o quedaría mal nombrado:

1. **ID del stack** en `infra/bin/gestion-proyectos.ts`: está fijo como `"GestionProyectosDevStack"`. Debe derivarse del ambiente, ej. `` `GestionProyectos${envName[0].toUpperCase()}${envName.slice(1)}Stack` ``.
2. **Script de deploy** en `infra/package.json`: `deploy` tiene `--profile gestion-proyectos-dev` fijo. Agregar `deploy:prod` con `--context envName=prod --profile <PERFIL_SSO_PROD>` (y considerar quitar `--require-approval never` en prod).
3. **Políticas de retención**: en dev conviene `RemovalPolicy.DESTROY`; en prod la tabla DynamoDB y el bucket frontend deben ser `RETAIN`, con PITR (point-in-time recovery) activado en la tabla. Condicionar por `envName` en `infra/lib/gestion-proyectos-stack.ts`.
4. **Protección del stack**: `terminationProtection: true` cuando `envName === "prod"`.

## 3. Procedimiento de despliegue

```bash
# 3.1 Perfil SSO para la cuenta prod (en ~/.aws/config) y login
aws sso login --profile <PERFIL_SSO_PROD>
aws sts get-caller-identity --profile <PERFIL_SSO_PROD>   # verificar cuenta correcta

# 3.2 Bootstrap CDK en la cuenta/región prod (una sola vez)
cd infra
npx cdk bootstrap aws://<CUENTA_PROD>/<REGION> --profile <PERFIL_SSO_PROD>

# 3.3 Validar síntesis sin desplegar
npx cdk synth --context envName=prod

# 3.4 Desplegar (crea TODOS los recursos prod, incluye backend Lambda y seed)
npx cdk deploy --context envName=prod \
  --context initialUserEmail=<CORREO_INICIAL> \
  --profile <PERFIL_SSO_PROD>
# Anotar los outputs: bucket, distribución, API URL, pool, client
```

## 4. Publicar el frontend en prod

```bash
# 4.1 Construir
cd frontend && pnpm build

# 4.2 Crear config.json prod (sección 1) p.ej. en /tmp/config-prod.json y subirlo
aws s3 cp /tmp/config-prod.json s3://gestion-proyectos-prod-frontend-<CUENTA_PROD>/config.json \
  --cache-control no-store --profile <PERFIL_SSO_PROD>

# 4.3 Sincronizar el build SIN pisar config.json
aws s3 sync dist/ s3://gestion-proyectos-prod-frontend-<CUENTA_PROD>/ \
  --delete --exclude config.json --profile <PERFIL_SSO_PROD>

# 4.4 Invalidar CloudFront
aws cloudfront create-invalidation --distribution-id <DIST_ID_PROD> \
  --paths "/*" --profile <PERFIL_SSO_PROD>
```

## 5. Datos y accesos (lo que NO viaja solo desde dev)

- **Usuarios Cognito**: prod arranca solo con `<CORREO_INICIAL>` (el seed lo crea con cambio de contraseña inicial). Los usuarios de dev no migran ni deben migrar. Los demás se crean desde el módulo Administración o por CLI.
- **DynamoDB**: arranca vacía (salvo el seed). Decidir explícitamente si prod inicia limpio (recomendado) o si se migra algo de dev con export/import de DynamoDB.
- **Catálogo**: ejecutar el sync (`POST /api/catalog/sync`) una vez haya permisos sobre Glue en prod.
- **Lake Formation / Glue del hub**: el punto más delicado y con dependencia externa. Los grants `DESCRIBE` que la cuenta `<CUENTA_HUB>` haya dado a dev **no aplican a prod**: hay que solicitar grants hacia `<CUENTA_PROD>`, crear los resource links en la cuenta prod y otorgar `DESCRIBE` sobre los links al rol de la Lambda prod. Gestionarlo con anticipación (ver `docs/07_catalogo_datalake.md`, sección "Visibilidad pendiente").

## 6. Deseable para producción (no bloqueante)

- `<DOMINIO_PROPIO>` con certificado ACM (en `us-east-1` para CloudFront) y alias en la distribución.
- Alarmas CloudWatch: errores 5xx de API/Lambda, throttling de DynamoDB.
- Retención de logs y revisión de costos (presupuesto/Budget en la cuenta).
- WAF en CloudFront/API si la política de la organización lo exige.

## 7. Checklist final

- [ ] Tabla de campos de la sección 1 completada y acordada.
- [ ] Ajustes de código de la sección 2 aplicados y validados con `npm run check`.
- [ ] Bootstrap hecho en `<CUENTA_PROD>`.
- [ ] Stack prod desplegado y outputs anotados.
- [ ] `config.json` prod subido y verificado (`curl https://<dominio>/config.json`).
- [ ] Frontend publicado e invalidado; login con `<CORREO_INICIAL>` funciona.
- [ ] Grants Lake Formation solicitados/aplicados para el rol Lambda prod.
- [ ] Sync de catálogo ejecutado y módulos visibles según permisos.
- [ ] Documentación actualizada: recursos prod registrados (equivalente a `docs/15_estado_implementacion.md`) y `AGENTS.md` si cambia la regla de perfiles.
