import os
from datetime import datetime, timezone
from typing import Any

import boto3

from core.errors import ValidationError
from repositories.catalog import CatalogRepository
from repositories.home import HomeRepository
from repositories.workspace import WorkspaceRepository

APP_ACCOUNT_ID = os.environ.get("APP_ACCOUNT_ID", "")
HUB_ACCOUNT_ID = os.environ.get("HUB_ACCOUNT_ID", "")
HUB_COST_ROLE_ARN = os.environ.get("HUB_COST_ROLE_ARN", "")

# TTL diferenciado: los meses cerrados ya no cambian (caché larga); el mes en
# curso cambia, pero AWS solo refresca Cost Explorer ~3 veces al día.
CACHE_TTL_CURRENT = 8 * 3600        # mes en curso (o futuro): 8 h
CACHE_TTL_CLOSED = 30 * 24 * 3600   # mes ya cerrado: 30 días


class HomeService:
    # El dashboard agrega varios dominios: depende de los repos que necesita.
    def __init__(self, workspace: WorkspaceRepository | None = None,
                 catalog: CatalogRepository | None = None,
                 costs: HomeRepository | None = None) -> None:
        self._workspace = workspace or WorkspaceRepository()
        self._catalog = catalog or CatalogRepository()
        self._costs = costs or HomeRepository()

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # ── Resumen operativo + catálogo ─────────────────────────────────────────

    def get_summary(self) -> dict[str, Any]:
        projects = self._workspace.list_projects()
        tasks = self._workspace.list_all_tasks()
        people = self._workspace.list_people()
        databases = self._catalog.list_catalog_databases()

        projects_by_status: dict[str, int] = {}
        for p in projects:
            projects_by_status[p.get("status") or "sin_estado"] = projects_by_status.get(p.get("status") or "sin_estado", 0) + 1

        tasks_by_status: dict[str, int] = {}
        for t in tasks:
            tasks_by_status[t.get("status") or "sin_estado"] = tasks_by_status.get(t.get("status") or "sin_estado", 0) + 1

        total_tables = 0
        total_bytes = 0
        db_sizes = []
        for db in databases:
            total_tables += int(db.get("tableCount", 0) or 0)
            stats = db.get("stats") or {}
            size = int(stats.get("sizeBytes", 0) or 0) if stats.get("available") else 0
            total_bytes += size
            db_sizes.append({"name": db.get("database", db.get("SK", "")), "sizeBytes": size, "tableCount": int(db.get("tableCount", 0) or 0)})

        db_sizes.sort(key=lambda d: d["sizeBytes"], reverse=True)

        return {
            "projects": {"total": len(projects), "byStatus": projects_by_status},
            "tasks": {"total": len(tasks), "byStatus": tasks_by_status},
            "people": {"total": len(people)},
            "catalog": {
                "databases": len(databases),
                "tables": total_tables,
                "sizeBytes": total_bytes,
                "topDatabases": db_sizes[:5],
            },
        }

    # ── Costos AWS (Cost Explorer) ───────────────────────────────────────────

    def _ce_client(self, account: str):
        if account == APP_ACCOUNT_ID:
            return boto3.client("ce", region_name="us-east-1")
        if account == HUB_ACCOUNT_ID:
            sts = boto3.client("sts")
            creds = sts.assume_role(
                RoleArn=HUB_COST_ROLE_ARN,
                RoleSessionName="gestion-proyectos-costs",
            )["Credentials"]
            return boto3.client(
                "ce", region_name="us-east-1",
                aws_access_key_id=creds["AccessKeyId"],
                aws_secret_access_key=creds["SecretAccessKey"],
                aws_session_token=creds["SessionToken"],
            )
        raise ValidationError("Cuenta no permitida.")

    def get_costs(self, account: str, start: str, end: str, force: bool = False) -> dict[str, Any]:
        account = (account or "").strip()
        if account not in {APP_ACCOUNT_ID, HUB_ACCOUNT_ID}:
            raise ValidationError("Cuenta no permitida.")
        self._validate_date(start, "inicio")
        self._validate_date(end, "fin")

        ttl = self._ttl_for_period(end)
        key = f"{account}#{start}#{end}"
        if not force:
            cached = self._costs.get_cost_cache(key)
            if cached:
                fetched_at = cached.get("fetchedAt", "")
                if self._fresh(fetched_at, ttl):
                    data = self._decode(cached.get("data") or {})
                    data["cached"] = True
                    data["fetchedAt"] = fetched_at
                    return data

        client = self._ce_client(account)
        data = self._fetch_costs(client, start, end)
        data["account"] = account
        data["start"] = start
        data["end"] = end
        now = self._now()
        self._costs.put_cost_cache(key, self._encode(data), now)
        data["cached"] = False
        data["fetchedAt"] = now
        return data

    def _fetch_costs(self, client, start: str, end: str) -> dict[str, Any]:
        period = {"Start": start, "End": end}

        # Conceptos (RECORD_TYPE) mensual.
        concepts_resp = client.get_cost_and_usage(
            TimePeriod=period, Granularity="MONTHLY", Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "RECORD_TYPE"}],
        )
        concepts = []
        net = 0.0
        groups = concepts_resp["ResultsByTime"][0]["Groups"] if concepts_resp.get("ResultsByTime") else []
        for g in groups:
            amount = float(g["Metrics"]["UnblendedCost"]["Amount"])
            net += amount
            concepts.append({"type": g["Keys"][0], "amount": self._fmt(amount)})

        # Costo por servicio (neto) mensual.
        service_resp = client.get_cost_and_usage(
            TimePeriod=period, Granularity="MONTHLY", Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        by_service = []
        sgroups = service_resp["ResultsByTime"][0]["Groups"] if service_resp.get("ResultsByTime") else []
        for g in sgroups:
            amount = float(g["Metrics"]["UnblendedCost"]["Amount"])
            if abs(amount) < 0.0001:
                continue
            by_service.append({"service": g["Keys"][0], "amount": self._fmt(amount)})
        by_service.sort(key=lambda s: float(s["amount"]), reverse=True)

        # Costo BRUTO por servicio (lo consumido, excluyendo créditos y reembolsos).
        gross_resp = client.get_cost_and_usage(
            TimePeriod=period, Granularity="MONTHLY", Metrics=["UnblendedCost"],
            Filter={"Not": {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}}},
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        gross_by_service = []
        gross_total = 0.0
        ggroups = gross_resp["ResultsByTime"][0]["Groups"] if gross_resp.get("ResultsByTime") else []
        for g in ggroups:
            amount = float(g["Metrics"]["UnblendedCost"]["Amount"])
            gross_total += amount
            if abs(amount) < 0.0001:
                continue
            gross_by_service.append({"service": g["Keys"][0], "amount": self._fmt(amount)})
        gross_by_service.sort(key=lambda s: float(s["amount"]), reverse=True)

        # Tendencia diaria (neto por día).
        daily_resp = client.get_cost_and_usage(
            TimePeriod=period, Granularity="DAILY", Metrics=["UnblendedCost"],
        )
        daily = [
            {"date": r["TimePeriod"]["Start"], "amount": self._fmt(float(r["Total"]["UnblendedCost"]["Amount"]))}
            for r in daily_resp.get("ResultsByTime", [])
        ]

        # Créditos por servicio.
        credits_resp = client.get_cost_and_usage(
            TimePeriod=period, Granularity="MONTHLY", Metrics=["UnblendedCost"],
            Filter={"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit"]}},
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        credits_by_service = []
        cgroups = credits_resp["ResultsByTime"][0]["Groups"] if credits_resp.get("ResultsByTime") else []
        for g in cgroups:
            amount = float(g["Metrics"]["UnblendedCost"]["Amount"])
            if abs(amount) < 0.0001:
                continue
            credits_by_service.append({"service": g["Keys"][0], "amount": self._fmt(amount)})
        credits_by_service.sort(key=lambda s: float(s["amount"]))

        return {
            "concepts": concepts,
            "net": self._fmt(net),
            "gross": self._fmt(gross_total),
            "byService": by_service[:10],
            "grossByService": gross_by_service[:10],
            "daily": daily,
            "creditsByService": credits_by_service,
        }

    def _fmt(self, value: float) -> str:
        return f"{value:.2f}"

    def _validate_date(self, value: str, label: str) -> None:
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except (ValueError, TypeError):
            raise ValidationError(f"Fecha de {label} inválida (use AAAA-MM-DD).")

    def _ttl_for_period(self, end: str) -> int:
        """Si el fin del periodo (exclusivo) ya pasó, el mes está cerrado y sus
        cifras no cambian → caché larga. Si no, es el mes en curso → caché corta."""
        try:
            end_dt = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return CACHE_TTL_CURRENT
        return CACHE_TTL_CLOSED if end_dt <= datetime.now(timezone.utc) else CACHE_TTL_CURRENT

    def _fresh(self, fetched_at: str, ttl: int) -> bool:
        try:
            dt = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return False
        age = (datetime.now(timezone.utc) - dt).total_seconds()
        return age < ttl

    # DynamoDB no acepta float: todas las cifras viajan como string, así que el
    # round-trip de caché no requiere conversión.
    def _encode(self, data: dict[str, Any]) -> dict[str, Any]:
        return data

    def _decode(self, data: dict[str, Any]) -> dict[str, Any]:
        return data
