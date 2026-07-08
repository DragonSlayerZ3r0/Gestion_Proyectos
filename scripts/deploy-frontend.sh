#!/usr/bin/env bash
# Publica el frontend a S3 + CloudFront de forma segura.
#
# Por qué existe:
#   El config.json de producción (Cognito + API) NO está en git: el public/config.json
#   local es un placeholder vacío para desarrollo. Un `aws s3 sync --delete dist/` ingenuo
#   sube ese placeholder y deja a los usuarios fuera ("Falta completar la configuración").
#
# Qué hace este script (idempotente):
#   1. Lee los valores reales desde los outputs de CloudFormation (fuente de verdad).
#   2. Compila el frontend (pnpm build).
#   3. Sincroniza dist/ con --delete PERO excluyendo config.json y basura de macOS.
#   4. Regenera y sube config.json con los valores reales (separado, nunca el placeholder).
#   5. Invalida CloudFront.
#
# Uso:
#   ./scripts/deploy-frontend.sh                 # dev (por defecto)
#   STACK=GestionProyectosProdStack PROFILE=...  ./scripts/deploy-frontend.sh   # otro entorno
set -euo pipefail

STACK="${STACK:-GestionProyectosDevStack}"
PROFILE="${PROFILE:-gestion-proyectos-dev}"
REGION="${REGION:-us-east-1}"
ENV_NAME="${ENV_NAME:-dev}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT/frontend"

echo "→ Leyendo outputs del stack $STACK ($PROFILE)…"
# Cada valor se lee de forma explícita por OutputKey (el orden de Outputs no está garantizado).
get_out() { aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
API_URL="$(get_out ApiUrl)"
POOL_ID="$(get_out UserPoolId)"
CLIENT_ID="$(get_out UserPoolClientId)"
DOMAIN_PREFIX="$(get_out CognitoDomain)"
BUCKET="$(get_out FrontendBucketName)"
DIST_ID="$(get_out DistributionId)"
WS_URL="$(get_out WebSocketUrl)"

if [[ -z "$BUCKET" || -z "$DIST_ID" || -z "$CLIENT_ID" ]]; then
  echo "✗ No se pudieron leer los outputs (¿sesión SSO vencida? prueba: aws sso login --sso-session bdr-fed)" >&2
  exit 1
fi

COGNITO_DOMAIN="https://${DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"

echo "  Bucket:       $BUCKET"
echo "  Distribution: $DIST_ID"
echo "  API:          $API_URL"

echo "→ Compilando frontend…"
( cd "$FRONTEND_DIR" && pnpm build )

# Aviso "desplegando" para los usuarios conectados (se limpia al final).
echo "→ Activando aviso de despliegue (deploy.json)…"
STACK="$STACK" PROFILE="$PROFILE" REGION="$REGION" "$ROOT/scripts/deploy-flag.sh" start

echo "→ Sincronizando assets (sin tocar config.json, deploy.json ni basura)…"
aws s3 sync "$FRONTEND_DIR/dist/" "s3://$BUCKET" --delete \
  --exclude "config.json" --exclude "deploy.json" --exclude ".DS_Store" \
  --profile "$PROFILE"

echo "→ Regenerando config.json de producción…"
TMP_CFG="$(mktemp)"
cat > "$TMP_CFG" <<JSON
{
  "environment": "$ENV_NAME",
  "region": "$REGION",
  "apiBaseUrl": "$API_URL",
  "cognitoUserPoolId": "$POOL_ID",
  "cognitoClientId": "$CLIENT_ID",
  "cognitoDomain": "$COGNITO_DOMAIN",
  "wsUrl": "$WS_URL"
}
JSON
aws s3 cp "$TMP_CFG" "s3://$BUCKET/config.json" --content-type application/json --profile "$PROFILE"
rm -f "$TMP_CFG"

echo "→ Invalidando CloudFront…"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
  --profile "$PROFILE" --query 'Invalidation.{Id:Id,Status:Status}' --output table

echo "→ Quitando aviso de despliegue…"
STACK="$STACK" PROFILE="$PROFILE" REGION="$REGION" "$ROOT/scripts/deploy-flag.sh" done

echo "✓ Listo."
