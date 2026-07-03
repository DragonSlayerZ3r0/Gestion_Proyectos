#!/usr/bin/env bash
# Bandera de "despliegue en curso" que la app muestra a los usuarios conectados.
#
# Sube /deploy.json al bucket del frontend (con no-store, junto a config.json).
# El frontend lo consulta cada minuto: mientras status="deploying" muestra un
# aviso discreto e intermitente ("se está publicando una nueva versión, evita
# guardar en este momento"); al volver a "ok" con un buildId nuevo, sugiere
# recargar. Si la bandera queda huérfana (deploy que murió a medias), el
# frontend la ignora pasados 30 min de startedAt.
#
# Uso:
#   ./scripts/deploy-flag.sh start    # antes de CUALQUIER deploy (backend o frontend)
#   ./scripts/deploy-flag.sh done     # al terminar
#
# deploy-frontend.sh lo llama solo; para deploys SOLO de backend (cdk deploy),
# llamarlo a mano alrededor del deploy.
set -euo pipefail

ACTION="${1:-}"
STACK="${STACK:-GestionProyectosDevStack}"
PROFILE="${PROFILE:-gestion-proyectos-dev}"
REGION="${REGION:-us-east-1}"

if [[ "$ACTION" != "start" && "$ACTION" != "done" ]]; then
  echo "Uso: $0 start|done" >&2
  exit 1
fi

BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" --output text)"
DIST_ID="$(aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)"

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP="$(mktemp)"
if [[ "$ACTION" == "start" ]]; then
  printf '{"status":"deploying","startedAt":"%s"}\n' "$NOW" > "$TMP"
else
  printf '{"status":"ok","finishedAt":"%s","buildId":"%s"}\n' "$NOW" "$(date +%s)" > "$TMP"
fi

# no-store: el aviso debe verse en ~1 min, no cuando CloudFront quiera.
aws s3api put-object --bucket "$BUCKET" --key deploy.json --body "$TMP" \
  --cache-control no-store --content-type application/json \
  --profile "$PROFILE" --region "$REGION" --no-cli-pager > /dev/null
rm -f "$TMP"

# Invalidación puntual (solo este archivo) por si algún edge lo tenía cacheado.
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/deploy.json" \
  --profile "$PROFILE" --query 'Invalidation.Id' --output text > /dev/null

echo "✓ deploy.json → $ACTION"
