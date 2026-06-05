# Estado de implementacion

## Corte actual

Primer entregable implementado y desplegado en `dev`:

- Monorepo con `frontend/`, `backend/`, `infra/` y `docs/`.
- Frontend Astro estatico con login/logout OIDC, carga de `/api/me` y menu dinamico por modulos.
- Backend Lambda Python con rutas `GET /health` y `GET /api/me`.
- Repositorio DynamoDB para perfil funcional y modulos de usuario.
- Infraestructura AWS CDK TypeScript para `dev`.
- Seed automatico en CDK para usuario inicial y modulos base.

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
- Cognito User Pool, dominio Hosted UI y App Client publico con Authorization Code + PKCE.
- API Gateway HTTP API.
- JWT Authorizer conectado al User Pool.
- Lambda Python `gestion-proyectos-dev-api`.
- DynamoDB `gestion-proyectos-dev-main` con `PK` y `SK`.
- CloudWatch Logs con retencion de 30 dias.
- Outputs para publicar frontend manualmente: bucket S3, distribucion CloudFront, API URL y valores Cognito.

## Perfil AWS

Usar siempre:

```bash
aws sts get-caller-identity --profile 186281981036_aws-ps-admin-analitica-bdr
```

El token actual vencio durante la implementacion local. Antes de desplegar, solicitar nuevas credenciales temporales y actualizar el perfil.

## Comandos validados

```bash
npm install
npm run build -w frontend
PYTHONPYCACHEPREFIX=/private/tmp/gestion-proyectos-pycache python3 -m py_compile backend/app/*.py backend/app/repositories/*.py backend/app/services/*.py backend/scripts/*.py
npm run build -w infra
npm run synth -w infra
npm run check
npm run infra:deploy
```

Resultado: todos pasan localmente.

El despliegue CDK termino en `CREATE_COMPLETE`.

## Publicacion frontend

El frontend se publica fuera de CDK para evitar depender de `BucketDeployment`:

```bash
npm run build -w frontend
aws s3 sync frontend/dist/ s3://gestion-proyectos-dev-frontend-186281981036/ --delete --profile 186281981036_aws-ps-admin-analitica-bdr --region us-east-1
aws s3 sync /private/tmp/gestion-proyectos-public-config/ s3://gestion-proyectos-dev-frontend-186281981036/ --cache-control no-store --profile 186281981036_aws-ps-admin-analitica-bdr --region us-east-1
aws cloudfront create-invalidation --distribution-id E2K3CA110228B1 --paths "/*" --profile 186281981036_aws-ps-admin-analitica-bdr
```

El archivo runtime `/config.json` debe contener solamente valores publicos del ambiente:

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

- `npm install` reporta vulnerabilidades transitivas: 8 moderadas y 2 altas. No se ejecuto `npm audit fix --force` para no romper versiones CDK/Astro.
- CDK emite advertencias por usar paquetes alpha de API Gateway v2 en version `2.114.1-alpha.0`; se aceptan por ahora para mantener HTTP API con JWT Authorizer.
- CDK advierte que Node `v25.9.0` no esta dentro del rango probado por esa version. El synth pasa; para despliegues repetibles conviene usar una version LTS de Node.
- `BucketDeployment` de CDK fallo previamente al copiar assets desde el bucket bootstrap cifrado con SSE-KMS. La pila final evita ese custom resource y publica el frontend con `aws s3 sync`.

## Pruebas realizadas

- `curl -I https://d269paz1z7q1g0.cloudfront.net/` devuelve `HTTP/2 200`.
- `curl https://d269paz1z7q1g0.cloudfront.net/config.json` devuelve los valores runtime reales.
- `curl -i https://63ibnl13da.execute-api.us-east-1.amazonaws.com/health` devuelve `HTTP/2 200` con `{ "status": "ok" }`.
- `curl -i https://63ibnl13da.execute-api.us-east-1.amazonaws.com/api/me` sin token devuelve `HTTP/2 401`, esperado por el JWT Authorizer.
- Invalidation CloudFront `I4TFMV0E5EWP6WSSMV7JWP3G99` termino en `Completed`.

## Siguiente paso operativo

1. Abrir `FrontendUrl`, completar el primer login del usuario inicial y definir contrasena si Cognito lo solicita.
2. Validar `/api/me` con token real desde el navegador.
3. Ajustar datos iniciales de modulos/roles si se requieren nombres funcionales definitivos.
