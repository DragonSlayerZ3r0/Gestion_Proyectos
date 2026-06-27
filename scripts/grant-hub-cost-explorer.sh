#!/usr/bin/env bash
# Crea/actualiza un rol que permite a la Lambda de Gestión de Proyectos (cuenta
# app 186281981036) leer Cost Explorer de OTRA cuenta vía AssumeRole. Se ejecuta
# en la cuenta destino con un perfil admin de ESA cuenta. El rol creado se llama
# igual en cada cuenta (gestion-proyectos-cost-reader) y confía en el rol del
# Lambda de la app.
#
#   # cuenta hub (data lake prod):
#   AWS_PROFILE=perfil_admin_dl ./scripts/grant-hub-cost-explorer.sh
#   # cualquier cuenta nueva: usar el perfil admin de esa cuenta
#   AWS_PROFILE=<perfil-admin-cuenta-nueva> ./scripts/grant-hub-cost-explorer.sh
#
# Después: agregar la cuenta a costAccounts en infra/lib/gestion-proyectos-stack.ts
# (mode "assume" + roleArn) y `cdk deploy`. Ver docs/02_modulos_funcionales.md.
# El rol de la Lambda lo crea el stack de la app (gestion-proyectos-dev-api-role).
#
# OJO: este script otorga SOLO Cost Explorer + CloudTrail (suficiente para cuentas
# de costo). El HUB (396913696127) necesita ADEMÁS Athena/Glue/S3 y el grant de
# Lake Formation para "registros del data lake" y el monitoreo de Athena — eso NO
# está aquí. Set COMPLETO del hub documentado en: docs/permisos_hub.md
set -euo pipefail

ROLE_NAME="gestion-proyectos-cost-reader"
LAMBDA_ROLE_ARN="arn:aws:iam::186281981036:role/gestion-proyectos-dev-api-role"

TRUST=$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"${LAMBDA_ROLE_ARN}"},"Action":"sts:AssumeRole"}]}
EOF
)
PERMS=$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ce:GetCostAndUsage","ce:GetCostForecast","ce:GetDimensionValues","cloudtrail:LookupEvents"],"Resource":"*"}]}
EOF
)

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Rol existe, actualizando trust policy…"
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST"
else
  echo "Creando rol $ROLE_NAME…"
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST" \
    --description "Permite a la Lambda de Gestion de Proyectos leer Cost Explorer del hub"
fi

aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name CostExplorerReadOnly --policy-document "$PERMS"

echo "Listo: arn:aws:iam::396913696127:role/${ROLE_NAME}"
