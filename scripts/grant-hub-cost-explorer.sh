#!/usr/bin/env bash
# Crea/actualiza en la cuenta hub (396913696127) un rol que permite a la Lambda de
# Gestión de Proyectos (cuenta app 186281981036) leer Cost Explorer del hub vía
# AssumeRole. Ejecutar con un perfil admin del hub (p. ej. perfil_admin_dl).
#
#   AWS_PROFILE=perfil_admin_dl ./scripts/grant-hub-cost-explorer.sh
#
# El rol de la Lambda lo crea el stack de la app (gestion-proyectos-dev-api-role).
set -euo pipefail

ROLE_NAME="gestion-proyectos-cost-reader"
LAMBDA_ROLE_ARN="arn:aws:iam::186281981036:role/gestion-proyectos-dev-api-role"

TRUST=$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"${LAMBDA_ROLE_ARN}"},"Action":"sts:AssumeRole"}]}
EOF
)
PERMS=$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ce:GetCostAndUsage","ce:GetCostForecast","ce:GetDimensionValues"],"Resource":"*"}]}
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
