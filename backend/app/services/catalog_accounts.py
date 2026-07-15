import json
import os
from typing import Any

import boto3

from core.errors import ValidationError

# Cuenta hub del data lake (fab-datos prod): el Glue Data Catalog "real" que la
# plataforma ya usa para Athena, monitoreo y chat SQL. Es la cuenta por defecto
# del módulo Catálogo.
HUB_ACCOUNT_ID = "396913696127"


def _load_catalog_accounts() -> list[dict[str, Any]]:
    """Cuentas cuyo Glue Data Catalog puede explorar el módulo Catálogo. Fuente
    única: la env var CATALOG_ACCOUNTS (la define el stack CDK; la PRIMERA es la
    cuenta por defecto). Formato: [{"id","name","mode":"direct"|"assume","roleArn"?}].
    Fallback transicional: derivarlas de COST_ACCOUNTS (hub primero, luego la
    cuenta app) mientras el deploy aún no define CATALOG_ACCOUNTS."""
    raw = os.environ.get("CATALOG_ACCOUNTS", "")
    if raw:
        try:
            accounts = [a for a in json.loads(raw) if a.get("id")]
            if accounts:
                return accounts
        except (json.JSONDecodeError, TypeError):
            pass
    fallback: list[dict[str, Any]] = []
    try:
        cost_accounts = {a["id"]: a for a in json.loads(os.environ.get("COST_ACCOUNTS", "[]")) if a.get("id")}
    except (json.JSONDecodeError, TypeError, KeyError):
        cost_accounts = {}
    hub = cost_accounts.get(HUB_ACCOUNT_ID)
    if hub:
        fallback.append(hub)
    fallback.extend(a for a in cost_accounts.values() if a.get("mode") == "direct")
    return fallback


CATALOG_ACCOUNTS: dict[str, dict[str, Any]] = {a["id"]: a for a in _load_catalog_accounts()}


def default_account_id() -> str:
    return next(iter(CATALOG_ACCOUNTS), HUB_ACCOUNT_ID)


def list_accounts() -> list[dict[str, str]]:
    """Cuentas para el selector del frontend (la primera es la default)."""
    return [{"id": a["id"], "name": a.get("name", a["id"])} for a in CATALOG_ACCOUNTS.values()]


def resolve_account(account_id: str | None) -> dict[str, Any]:
    """Config de la cuenta pedida (whitelist) o la default si no se pide."""
    account_id = (account_id or "").strip()
    if not account_id:
        account_id = default_account_id()
    cfg = CATALOG_ACCOUNTS.get(account_id)
    if not cfg:
        raise ValidationError("Cuenta de catálogo no habilitada.")
    return cfg


def glue_client(cfg: dict[str, Any]):
    """Cliente Glue de la cuenta: mode 'direct' usa el rol de la Lambda; mode
    'assume' asume el rol cross-account de esa cuenta (mismo patrón que costos)."""
    if cfg.get("mode") != "assume":
        return boto3.client("glue")
    role_arn = cfg.get("roleArn", "")
    if not role_arn:
        raise ValidationError("Cuenta sin rol cross-account configurado.")
    creds = boto3.client("sts").assume_role(
        RoleArn=role_arn,
        RoleSessionName="gestion-proyectos-catalog",
    )["Credentials"]
    return boto3.client(
        "glue",
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
    )
