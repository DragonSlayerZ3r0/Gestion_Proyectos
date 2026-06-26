#!/usr/bin/env bash
#
# Otorga acceso de SOLO LECTURA (listar para calcular tamaño/frescura) al rol de
# la Lambda del catálogo sobre un bucket del data lake que vive en la cuenta hub
# 396913696127 (ej. arc-enterprise-data).
#
# IMPORTANTE:
#  - put-bucket-policy REEMPLAZA la política completa. Este script NO sobrescribe:
#    lee la política actual, le AGREGA una sentencia y vuelve a aplicarla, dejando
#    primero un backup con timestamp.
#  - El rol destino debe EXISTIR antes de ejecutar (S3 rechaza principals
#    inexistentes). Por eso: primero `npm run infra:deploy` para crear
#    `gestion-proyectos-dev-api-role`, y luego correr este script.
#  - Requiere `jq` y un perfil con permiso s3:PutBucketPolicy en la cuenta hub
#    (perfil `bdr-fed` = cuenta 396913696127, rol aws-ps-admin-analitica-bdr).
#
# Uso:
#   ./scripts/grant-datalake-s3.sh <bucket> <role_arn> [perfil]
# Ejemplo:
#   ./scripts/grant-datalake-s3.sh arc-enterprise-data \
#     arn:aws:iam::186281981036:role/gestion-proyectos-dev-api-role bdr-fed
#
set -euo pipefail

BUCKET="${1:?Falta el nombre del bucket}"
ROLE_ARN="${2:?Falta el ARN del rol de la Lambda}"
PROFILE="${3:-bdr-fed}"
SID="GestionProyectosCatalogReadOnly"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="bucket-policy-${BUCKET}-${STAMP}.json"

echo "→ Cuenta del perfil $PROFILE:"
aws sts get-caller-identity --profile "$PROFILE" --query Account --output text

echo "→ Backup de la política actual en: $BACKUP"
# Si el bucket no tiene política, partimos de una vacía.
CURRENT="$(aws s3api get-bucket-policy --bucket "$BUCKET" --profile "$PROFILE" --query Policy --output text 2>/dev/null || echo '{"Version":"2012-10-17","Statement":[]}')"
echo "$CURRENT" > "$BACKUP"

echo "→ Fusionando sentencia de solo lectura (Sid=$SID) para el rol:"
echo "  $ROLE_ARN"
# Quita cualquier sentencia previa con el mismo Sid (idempotente) y agrega la nueva.
MERGED="$(echo "$CURRENT" | jq \
  --arg sid "$SID" \
  --arg role "$ROLE_ARN" \
  --arg b "arn:aws:s3:::$BUCKET" '
  .Statement = ([.Statement[] | select(.Sid != $sid)] + [{
    "Sid": $sid,
    "Effect": "Allow",
    "Principal": { "AWS": $role },
    "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
    "Resource": $b
  }])')"

echo "→ Política resultante:"
echo "$MERGED" | jq .

read -r -p "¿Aplicar esta política a $BUCKET? (y/N) " ans
[ "$ans" = "y" ] || { echo "Cancelado. Backup en $BACKUP"; exit 0; }

aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$MERGED" --profile "$PROFILE"
echo "✓ Política aplicada. Para revertir:"
echo "  aws s3api put-bucket-policy --bucket $BUCKET --policy file://$BACKUP --profile $PROFILE"
