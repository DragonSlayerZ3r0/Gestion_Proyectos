# Desarrollo local y publicación

## Resumen

Este proyecto utiliza una arquitectura serverless por capas.

La separación principal es:

- `frontend/`: interfaz Astro estática.
- `backend/`: Lambda Python con adaptador HTTP, servicios y repositorios.
- `infra/`: AWS CDK TypeScript para definir infraestructura.
- `docs/`: contexto funcional, técnico y operativo.

## Diagrama de componentes

→ **[Abrir guía visual de desarrollo y publicación](Guia%2004%20-%20Desarrollo%20y%20publicacion.canvas)**

La guía separa el trabajo local, la validación, los cambios de backend o infraestructura,
la publicación del frontend y la verificación final.

## Capas de backend

La Lambda se organiza por capas simples:

- `handler.py`: recibe el evento de API Gateway, resuelve ruta/método y llama servicios.
- `auth.py`: extrae identidad desde claims validados por API Gateway JWT Authorizer.
- `services/`: contiene reglas funcionales y validaciones de negocio.
- `repositories/`: encapsula DynamoDB y evita que la lógica funcional dependa de llamadas directas de bajo nivel.
- `responses.py`: estandariza respuestas `{ ok, data, error }`.

Regla: el frontend accede a DynamoDB, Glue, Athena y S3 Data Lake exclusivamente mediante API Gateway y Lambda.

## Puertos y endpoints

| Uso | Valor |
| --- | --- |
| Frontend local Astro | `http://127.0.0.1:4321/` |
| Preview local Astro | `http://127.0.0.1:4321/` si el puerto está libre |
| Backend durante desarrollo | Lambda publicada en el ambiente `dev`; depuración mediante CloudWatch Logs |
| Frontend dev publicado | `https://d269paz1z7q1g0.cloudfront.net/` |
| API dev publicada | `https://63ibnl13da.execute-api.us-east-1.amazonaws.com/` |
| CloudFront/API Gateway | HTTPS `443` |
| Región AWS dev | `us-east-1` |
| Perfil AWS | `gestion-proyectos-dev` |

Si `4321` está ocupado, Astro puede usar otro puerto. En ese caso revisar que Cognito tenga callback/logout permitido para la URL local usada.

## Configuración runtime

El frontend lee `/config.json` en runtime.

El archivo versionado `frontend/public/config.json` se mantiene como plantilla local sin secretos:

```json
{
  "environment": "local",
  "region": "us-east-1",
  "apiBaseUrl": "",
  "cognitoUserPoolId": "",
  "cognitoClientId": "",
  "cognitoDomain": ""
}
```

Para pruebas locales contra AWS dev, se pueden usar los valores públicos del ambiente:

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

`config.json` contiene exclusivamente valores públicos de runtime. Los secretos, tokens temporales y credenciales AWS permanecen en los servicios de identidad y perfiles SSO.

## Desarrollo local

El workspace usa `pnpm` (`pnpm-workspace.yaml`). Instalar dependencias:

```bash
pnpm install
```

Levantar frontend:

```bash
cd frontend
pnpm dev
```

Abrir:

```text
http://127.0.0.1:4321/
```

Validar todo antes de publicar:

```bash
npm run check
```

`npm run check` ejecuta:

- Build y validación de Astro.
- Compilación Python con `py_compile`.
- `cdk synth`.

## Dónde se desarrolla y dónde se despliega

Existe un único working directory local para este proyecto: `/Users/josbel/Documents/Dev_Code/Gestion_Proyectos` (sin `git worktree` adicionales salvo que se cree uno explícitamente para una tarea puntual). No hay un ambiente de desarrollo "separado" del de despliegue: son la misma carpeta en disco.

Punto clave para evitar confusión entre sesiones de trabajo (por ejemplo, una sesión de Claude Code donde se conversa/edita código y otra distinta donde se ejecuta el despliegue):

- **Los comandos de despliegue** (`cdk deploy`, `scripts/deploy-frontend.sh`, `aws lambda update-function-code`) toman el código **tal como está en el filesystem en ese momento**. No dependen de qué sesión de chat lo escribió, ni de si hay un commit de por medio — leen los archivos del working directory directamente.
- Por lo tanto, si el código se edita en una sesión y el despliegue se ejecuta en otra (u otra pestaña/terminal), **ambas ven exactamente el mismo estado** porque apuntan a la misma carpeta. No hay dos copias del código; "otra sesión despliega" no significa "otro código", significa que el despliegue se disparó desde otra conversación mientras el archivo ya tenía los cambios guardados en disco.
- La confusión típica ocurre al revés: una sesión de desarrollo asume que "ya se desplegó" porque lo vio funcionar, cuando en realidad el despliegue ocurrió en una sesión anterior sobre un estado del código que **ya no es el actual** (se siguió editando después). El código nuevo queda escrito en disco pero no publicado hasta el próximo `cdk deploy` / `deploy-frontend.sh`.
- **Antes de dar por hecho que algo "ya está en dev"**, correr `git status` / `git diff` para ver si hay cambios sin desplegar, y si es necesario, verificar directamente en AWS (`LastModified` de la Lambda, o el contenido real descargado) en vez de asumir por lo que se recuerda de otra conversación.
- Recomendación operativa: cuando se sepa que el despliegue va a correr en otra sesión/terminal, dejarlo explícito en esa conversación (qué se cambió y por qué se debe publicar) en vez de asumir que "la otra sesión ya sabe".

## Validación AWS previa

Antes de acciones AWS relevantes:

```bash
aws sts get-caller-identity --profile gestion-proyectos-dev --region us-east-1 --no-cli-pager
```

Si la sesión SSO expiró:

```bash
aws sso login --sso-session bdr-fed
```

Usar el perfil SSO `gestion-proyectos-dev` como flujo normal y mantener credenciales temporales fuera de archivos y comandos del proyecto.

## Aviso de despliegue a usuarios conectados (obligatorio en TODO deploy)

Hay usuarios probando la plataforma mientras se desarrolla. Para que no guarden cambios justo cuando algo se está publicando, la app muestra un **aviso discreto e intermitente** (píldora ámbar abajo al centro: "Se está publicando una nueva versión — evita guardar cambios en este momento") mientras exista un despliegue en curso, y al terminar ofrece **"Recargar"** si detecta versión nueva.

Cómo funciona:
- La bandera es el archivo **`/deploy.json` en el bucket del frontend** (`{"status":"deploying"|"ok", ...}`), subido con `no-store` — costo cero (sin Lambda/DynamoDB). El frontend (`app.ts → startDeployWatch`) lo consulta **cada 60 s**; banderas huérfanas (>30 min) se ignoran por si un deploy murió a medias.
- **`scripts/deploy-flag.sh start|done`** sube/limpia la bandera (e invalida solo `/deploy.json` en CloudFront).
- **`scripts/deploy-frontend.sh` la maneja solo** (start antes del sync, done al final). El sync excluye `deploy.json` igual que `config.json`.

**Regla operativa: cualquier despliegue debe avisar.** Para deploys SOLO de backend (cdk), envolverlo a mano:

```bash
./scripts/deploy-flag.sh start
( cd infra && npx cdk deploy --profile gestion-proyectos-dev --require-approval never )
./scripts/deploy-flag.sh done
```

Si un deploy aborta a medias, correr `./scripts/deploy-flag.sh done` para limpiar la bandera (o esperar los 30 min de tolerancia).

## Publicación de backend

La infraestructura define la Lambda desde `backend/app`. Para publicar cambios de código backend sin cambiar infraestructura:

```bash
cd backend/app
zip -r /private/tmp/gestion-proyectos-api.zip .
cd ../..
aws lambda update-function-code \
  --function-name gestion-proyectos-dev-api \
  --zip-file fileb:///private/tmp/gestion-proyectos-api.zip \
  --profile gestion-proyectos-dev \
  --region us-east-1 \
  --no-cli-pager
aws lambda wait function-updated \
  --function-name gestion-proyectos-dev-api \
  --profile gestion-proyectos-dev \
  --region us-east-1
```

Validar salud:

```bash
curl -i https://63ibnl13da.execute-api.us-east-1.amazonaws.com/health
```

## Publicación de frontend

### Método recomendado: `scripts/deploy-frontend.sh`

Usar siempre este script. Compila, sincroniza los assets **excluyendo `config.json` y `.DS_Store`**, y **regenera `config.json` desde los outputs reales del stack** (Cognito + API), por lo que no depende de un archivo temporal ni puede dejar a los usuarios fuera:

```bash
./scripts/deploy-frontend.sh                                  # dev (por defecto)
STACK=GestionProyectosProdStack PROFILE=<perfil> ENV_NAME=prod ./scripts/deploy-frontend.sh
```

> ⚠️ **Nunca** correr `aws s3 sync dist/ ... --delete` sin `--exclude config.json`. El `frontend/public/config.json` versionado es un placeholder vacío (`environment: local`); un sync sin exclusión lo sube y borra el `config.json` real de producción → la pantalla de login muestra "Falta completar la configuración de acceso" y nadie puede entrar. El `config.json` real **solo vive en S3**, no en git.

### Flujo manual equivalente (si no se usa el script)

```bash
cd frontend
pnpm build
cp /tmp/config-prod.json dist/config.json
aws s3 sync dist/ s3://gestion-proyectos-dev-frontend-186281981036 \
  --delete \
  --profile gestion-proyectos-dev \
  --exclude config.json --exclude .DS_Store
aws cloudfront create-invalidation \
  --distribution-id E2K3CA110228B1 \
  --paths "/*" \
  --profile gestion-proyectos-dev
```

El `--exclude config.json` evita que el sync sobrescriba o borre el config publicado. Si `/tmp/config-prod.json` no existe, recrearlo con los valores públicos de `dev` documentados en `docs/15_estado_implementacion.md`.

Alternativa para restaurar solo `/config.json` con `no-store`:

```bash
aws s3api put-object \
  --bucket gestion-proyectos-dev-frontend-186281981036 \
  --key config.json \
  --body /tmp/config-prod.json \
  --cache-control no-store \
  --content-type application/json \
  --profile gestion-proyectos-dev \
  --region us-east-1 \
  --no-cli-pager
```

Invalidar CloudFront:

```bash
aws cloudfront create-invalidation \
  --distribution-id E2K3CA110228B1 \
  --paths "/*" \
  --profile gestion-proyectos-dev \
  --no-cli-pager
```

Esperar invalidación:

```bash
aws cloudfront wait invalidation-completed \
  --distribution-id E2K3CA110228B1 \
  --id <INVALIDATION_ID> \
  --profile gestion-proyectos-dev
```

## Verificación publicada

Validar frontend:

```bash
curl -I --http1.1 https://d269paz1z7q1g0.cloudfront.net/
```

Validar config runtime:

```bash
curl -s --http1.1 https://d269paz1z7q1g0.cloudfront.net/config.json
aws s3api head-object \
  --bucket gestion-proyectos-dev-frontend-186281981036 \
  --key config.json \
  --profile gestion-proyectos-dev \
  --region us-east-1 \
  --no-cli-pager
```

Validar API:

```bash
curl -i --http1.1 https://63ibnl13da.execute-api.us-east-1.amazonaws.com/health
```

## Publicación de infraestructura

Usar CDK cuando cambien recursos AWS, rutas, permisos, tablas, Cognito, CloudFront o configuración estructural:

```bash
npm run infra:synth
npm run infra:deploy
```

En este proyecto, algunos cambios operativos se publican con AWS CLI para evitar bloquear avances por problemas del `BucketDeployment` o resolución SSO del CDK CLI. Cuando se use CLI, el CDK debe quedar sincronizado con el estado deseado en `infra/`.

## Reglas operativas

- Mantener textos visibles en español.
- Mantener `docs/` sincronizado con cambios reales.
- Validar permisos en backend y reflejarlos en los controles visibles del frontend.
- Servir el frontend mediante CloudFront desde un bucket S3 privado.
- Mantener secretos y credenciales temporales fuera del repositorio.
- Validar STS antes de publicar en AWS.
