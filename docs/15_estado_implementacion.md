# Estado de implementación

## Corte actual

Primer entregable implementado y desplegado en `dev`:

- Monorepo con `frontend/`, `backend/`, `infra/` y `docs/`.
- Frontend Astro estático con login Cognito propio en español, opción de cancelar, cambio de contraseña inicial, carga de `/api/me` y menú dinámico por módulos.
- Backend Lambda Python con rutas `GET /health` y `GET /api/me`.
- API inicial de proyectos/tareas con workspace, creación rápida y actualización de tareas.
- UX de `Proyectos y tareas` publicada como una sola mesa de trabajo: personas, proyectos y tareas conviven en la misma pantalla; el menú ya no separa `Tareas` como ventana independiente.
- Panel de detalle contextual publicado para editar persona, proyecto, rol de miembro y tarea desde la misma pantalla.
- Ajuste UX publicado para `Proyectos y tareas`: creación de personas y tareas colapsada hasta presionar `Crear`, tarjetas de tareas más compactas y detalle abierto solo por botón explícito `Detalle`.
- Corrección frontend publicada para creación/edición de formularios: se conserva la referencia del formulario antes de llamadas asíncronas para evitar errores `currentTarget` nulo al crear usuarios, proyectos o tareas.
- Repositorio DynamoDB para perfil funcional y módulos de usuario.
- Infraestructura AWS CDK TypeScript para `dev`.
- Seed automático en CDK para usuario inicial y módulos base.

## Recursos desplegados

| Recurso | Valor |
| --- | --- |
| Stack | `GestionProyectosDevStack` |
| Frontend URL | `https://d269paz1z7q1g0.cloudfront.net/` |
| API URL | `https://63ibnl13da.execute-api.us-east-1.amazonaws.com/` |
| S3 frontend bucket | `gestion-proyectos-dev-frontend-186281981036` |
| CloudFront distribution | `E2K3CA110228B1` |
| Cognito User Pool | `us-east-1_lN4JYAVlQ` |
| Cognito App Client | `uhquk1hakj8nifgi3j6hv8dbh` |
| Cognito domain prefix | `gestion-proyectos-dev-186281981036` |
| DynamoDB table | `gestion-proyectos-dev-main` |
| Usuario inicial | `usr041100@banrural.com.gt` |

## Recursos definidos por CDK

- S3 privado para frontend: `gestion-proyectos-dev-frontend-186281981036`.
- CloudFront con acceso privado al bucket.
- Cognito User Pool, dominio Hosted UI disponible como respaldo y App Client público.
- API Gateway HTTP API.
- JWT Authorizer conectado al User Pool.
- Lambda Python `gestion-proyectos-dev-api`.
- DynamoDB `gestion-proyectos-dev-main` con `PK` y `SK`.
- CloudWatch Logs con retención de 30 días.
- Outputs para publicar frontend manualmente: bucket S3, distribución CloudFront, API URL y valores Cognito.

## Perfil AWS

Usar siempre:

```bash
aws sts get-caller-identity --profile gestion-proyectos-dev --region us-east-1 --no-cli-pager
```

Las credenciales del perfil son temporales y se renuevan con AWS SSO. Antes de acciones AWS relevantes, validar sesión con STS. Si SSO expiró, solicitar al usuario ejecutar `aws sso login --sso-session bdr-fed`.

## Comandos validados

```bash
npm install
npm run build -w frontend
PYTHONPYCACHEPREFIX=/private/tmp/gestion-proyectos-pycache python3 -m py_compile backend/app/*.py backend/app/repositories/*.py backend/app/services/*.py backend/scripts/*.py
npm run build -w infra
npm run synth -w infra
npm run check
```

Resultado: pasan localmente.

El despliegue CDK terminó en `CREATE_COMPLETE`.

En el ajuste de login del 2026-06-05, `npm run infra:deploy` no pudo aplicar el cambio porque el CDK CLI no resolvió las credenciales SSO del perfil, aunque `aws sts` y AWS CLI sí funcionaban con `gestion-proyectos-dev`. Para no bloquear el cambio, se actualizó el App Client con AWS CLI y el CDK quedó sincronizado con el mismo estado deseado.

```bash
aws cognito-idp update-user-pool-client \
  --user-pool-id us-east-1_lN4JYAVlQ \
  --client-id uhquk1hakj8nifgi3j6hv8dbh \
  --client-name gestion-proyectos-dev-web \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --callback-urls http://localhost:4321/ https://d269paz1z7q1g0.cloudfront.net/ \
  --logout-urls http://localhost:4321/ https://d269paz1z7q1g0.cloudfront.net/ \
  --supported-identity-providers COGNITO \
  --allowed-o-auth-flows-user-pool-client \
  --prevent-user-existence-errors ENABLED \
  --access-token-validity 60 \
  --id-token-validity 60 \
  --refresh-token-validity 1440 \
  --token-validity-units AccessToken=minutes,IdToken=minutes,RefreshToken=minutes \
  --profile gestion-proyectos-dev \
  --region us-east-1
```

En el corte de proyectos/tareas del 2026-06-05 se usó el mismo criterio operativo: CDK queda sincronizado, pero la actualización publicada se aplicó con AWS CLI. Acciones realizadas:

- `aws lambda update-function-code` para `gestion-proyectos-dev-api`.
- `aws apigatewayv2 create-route` para `GET /api/workspace`, `POST /api/people`, `POST /api/projects`, `POST /api/projects/{projectId}/members`, `POST /api/projects/{projectId}/tasks` y `PATCH /api/projects/{projectId}/tasks/{taskId}`.
- `aws lambda add-permission` para permitir invocación desde las rutas `/api/*`.

En el corte de panel de detalle del 2026-06-05 se aplicaron con AWS CLI:

- `aws lambda update-function-code` para `gestion-proyectos-dev-api`.
- `aws apigatewayv2 create-route` para `PATCH /api/people/{personId}`, `PATCH /api/projects/{projectId}` y `PATCH /api/projects/{projectId}/members/{personId}`.
- `aws apigatewayv2 update-api` para permitir `PATCH` en CORS desde CloudFront.
- `aws lambda add-permission` para permitir invocación desde las nuevas rutas `PATCH`.

## Publicación frontend

El frontend se publica fuera de CDK para evitar depender de `BucketDeployment`:

```bash
npm run build -w frontend
aws s3 sync frontend/dist/ s3://gestion-proyectos-dev-frontend-186281981036/ --delete --profile gestion-proyectos-dev --region us-east-1
aws s3 sync /private/tmp/gestion-proyectos-public-config/ s3://gestion-proyectos-dev-frontend-186281981036/ --cache-control no-store --profile gestion-proyectos-dev --region us-east-1
aws cloudfront create-invalidation --distribution-id E2K3CA110228B1 --paths "/*" --profile gestion-proyectos-dev
```

El archivo runtime `/config.json` debe contener solamente valores públicos del ambiente:

```json
{
  "environment": "dev",
  "region": "us-east-1",
  "apiBaseUrl": "https://63ibnl13da.execute-api.us-east-1.amazonaws.com/",
  "cognitoUserPoolId": "us-east-1_lN4JYAVlQ",
  "cognitoClientId": "uhquk1hakj8nifgi3j6hv8dbh",
  "cognitoDomain": "gestion-proyectos-dev-186281981036"
}
```

## Advertencias actuales

- `npm install` reporta vulnerabilidades transitivas: 8 moderadas y 2 altas. No se ejecutó `npm audit fix --force` para no romper versiones CDK/Astro.
- CDK emite advertencias por usar paquetes alpha de API Gateway v2 en versión `2.114.1-alpha.0`; se aceptan por ahora para mantener HTTP API con JWT Authorizer.
- CDK advierte que Node `v25.9.0` no está dentro del rango probado por esa versión. El synth pasa; para despliegues repetibles conviene usar una versión LTS de Node.
- `BucketDeployment` de CDK falló previamente al copiar assets desde el bucket bootstrap cifrado con SSE-KMS. La pila final evita ese custom resource y publica el frontend con `aws s3 sync`.

## Pruebas realizadas

- `curl -I https://d269paz1z7q1g0.cloudfront.net/` devuelve `HTTP/2 200`.
- `curl https://d269paz1z7q1g0.cloudfront.net/config.json` devuelve los valores runtime reales.
- `curl -i https://63ibnl13da.execute-api.us-east-1.amazonaws.com/health` devuelve `HTTP/2 200` con `{ "status": "ok" }`.
- `curl -i https://63ibnl13da.execute-api.us-east-1.amazonaws.com/api/me` sin token devuelve `HTTP/2 401`, esperado por el JWT Authorizer.
- `npm run check` pasa con build frontend, compilación Python y synth CDK.
- Invalidation CloudFront `I1WXOKWHFS865T5G4OODVK2YGM` terminó en `Completed` para el login propio con opción de cancelar.
- Invalidation CloudFront `IAR5ROM62ZVE5HWZITTEDTFQEK` terminó en `Completed` para la mesa de trabajo de proyectos/tareas.
- Cognito App Client confirma `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_USER_SRP_AUTH` y `ALLOW_REFRESH_TOKEN_AUTH`.
- Invocación directa de Lambda para `GET /api/workspace` con el usuario inicial devuelve `ok: true` y colecciones vacías listas para trabajar.
- Invalidation CloudFront `I9MLVS90MSBW526FYCB8FQUYKJ` terminó en `Completed` para la UX unificada de proyectos/tareas.
- Invocación directa de Lambda para `GET /api/me` con el usuario inicial devuelve `ok: true` y módulos ordenados por prioridad funcional.
- Invalidation CloudFront `I2F1PDL8YPUDNE23CFEFSUA0HX` terminó en `Completed` para el panel de detalle.
- Invalidation CloudFront `I1WEPCARA5O1OWVGU8ILWD6NRB` terminó en `Completed` para el ajuste UX de formularios colapsados y detalle explícito de tareas.
- Invalidation CloudFront `I9MROWSUVDA5CBY8AGQFXH569W` terminó en `Completed` para la corrección de formularios con `currentTarget` nulo.
- Invocaciones directas de Lambda validan edición de persona, proyecto, rol de miembro y tarea.
- DynamoDB registra `AUDIT_EVENT` para cambios de tarea en `status`, `priority` y `assigneePersonId`.
- Validación negativa: prioridad inválida devuelve `400 VALIDATION_ERROR`.
- Validación negativa: usuario sin módulos funcionales devuelve `403 FORBIDDEN`.
- Preflight CORS `OPTIONS` para `PATCH` desde CloudFront devuelve `204` con `access-control-allow-methods` incluyendo `PATCH`.
- Verificación publicada: CloudFront devuelve `HTTP/1.1 200`, `/config.json` conserva los valores runtime reales y el bundle servido contiene `togglePersonFormButton`, `toggleTaskFormButton`, `data-detail-task` y layout `280px minmax(0,1fr)`.
- Verificación publicada del fix de formularios: el bundle servido por CloudFront usa una referencia local del formulario antes de `await` y ejecuta `reset()` sobre esa referencia.

## Siguiente paso operativo

1. Probar con sesión real la pantalla `Proyectos y tareas`: seleccionar persona, proyecto y tarea, editar desde el panel lateral y confirmar persistencia.
2. Agregar comentarios simples a tareas si el flujo de edición queda aprobado.
3. Iniciar integración de Catálogo Data Lake solo cuando la mesa operativa quede validada.

Usuario inicial para prueba: `usr041100@banrural.com.gt`.
