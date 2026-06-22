import json
import os
from datetime import datetime, timezone
from typing import Any

import boto3

from core.errors import ValidationError
from repositories.catalog import CatalogRepository
from repositories.home import HomeRepository
from repositories.workspace import WorkspaceRepository


def _load_cost_accounts() -> dict[str, dict[str, Any]]:
    """Cuentas habilitadas para el dashboard de costos. Fuente única: la env var
    COST_ACCOUNTS (la define el stack CDK a partir de su lista costAccounts).
    Formato: [{"id","name","mode":"direct"|"assume","roleArn"?}].
    Fallback a las env vars antiguas por compatibilidad durante la transición."""
    raw = os.environ.get("COST_ACCOUNTS", "")
    if raw:
        try:
            return {a["id"]: a for a in json.loads(raw) if a.get("id")}
        except (json.JSONDecodeError, TypeError, KeyError):
            pass
    accounts: dict[str, dict[str, Any]] = {}
    app_id = os.environ.get("APP_ACCOUNT_ID", "")
    if app_id:
        accounts[app_id] = {"id": app_id, "name": app_id, "mode": "direct"}
    hub_id = os.environ.get("HUB_ACCOUNT_ID", "")
    if hub_id:
        accounts[hub_id] = {"id": hub_id, "name": hub_id, "mode": "assume",
                            "roleArn": os.environ.get("HUB_COST_ROLE_ARN", "")}
    return accounts


COST_ACCOUNTS = _load_cost_accounts()

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

    def list_cost_accounts(self) -> list[dict[str, str]]:
        """Cuentas para el selector del frontend: id + nombre legible. El frontend
        arma la etiqueta como 'nombre (id)'."""
        return [
            {"id": a["id"], "name": a.get("name") or a["id"]}
            for a in COST_ACCOUNTS.values()
        ]

    def _ce_client(self, account: str):
        cfg = COST_ACCOUNTS.get(account)
        if not cfg:
            raise ValidationError("Cuenta no permitida.")
        if cfg.get("mode") == "direct":
            return boto3.client("ce", region_name="us-east-1")
        # mode "assume": Cost Explorer de otra cuenta vía sts:AssumeRole.
        role_arn = cfg.get("roleArn")
        if not role_arn:
            raise ValidationError("Cuenta sin rol cross-account configurado.")
        sts = boto3.client("sts")
        creds = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName="gestion-proyectos-costs",
        )["Credentials"]
        return boto3.client(
            "ce", region_name="us-east-1",
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )

    def get_costs(self, account: str, start: str, end: str, force: bool = False) -> dict[str, Any]:
        account = (account or "").strip()
        if account not in COST_ACCOUNTS:
            raise ValidationError("Cuenta no permitida.")
        self._validate_date(start, "inicio")
        self._validate_date(end, "fin")

        ttl = self._ttl_for_period(end)
        key = f"{account}#{start}#{end}"
        if force:
            # "Actualizar ahora" refresca TODO el periodo: invalida también el
            # diario y los detalles por servicio (no solo el costo principal),
            # para que un único refresco deje todo coherente y al día.
            self._costs.delete_cost_cache_prefix(key)
        else:
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

    def get_service_detail(self, account: str, service: str, start: str, end: str,
                           force: bool = False) -> dict[str, Any]:
        """Desglose de un servicio por tipo de uso (USAGE_TYPE): el 'qué exactamente'
        se está consumiendo (p. ej. SageMaker → Studio, training por instancia).
        Es consumo bruto (excluye créditos/reembolsos). Caché propia por servicio."""
        account = (account or "").strip()
        service = (service or "").strip()
        if account not in COST_ACCOUNTS:
            raise ValidationError("Cuenta no permitida.")
        if not service:
            raise ValidationError("Servicio requerido.")
        self._validate_date(start, "inicio")
        self._validate_date(end, "fin")

        ttl = self._ttl_for_period(end)
        key = f"{account}#{start}#{end}#svc#{service}"
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
        data = self._fetch_service_detail(client, service, start, end)
        data["account"] = account
        data["service"] = service
        data["start"] = start
        data["end"] = end
        now = self._now()
        self._costs.put_cost_cache(key, self._encode(data), now)
        data["cached"] = False
        data["fetchedAt"] = now
        return data

    def get_daily_by_service(self, account: str, start: str, end: str,
                             force: bool = False, cached_only: bool = False) -> dict[str, Any]:
        """Costo por día y por servicio (consumo bruto). Una sola llamada a CE
        devuelve todo el mes; el frontend compara día contra día para detectar
        picos e identificar el servicio que los causó. Caché propia.

        cached_only=True: devuelve el dato SOLO si ya está en caché fresco; si no,
        devuelve {"pending": True} sin consultar AWS (para auto-mostrar sin costo)."""
        account = (account or "").strip()
        if account not in COST_ACCOUNTS:
            raise ValidationError("Cuenta no permitida.")
        self._validate_date(start, "inicio")
        self._validate_date(end, "fin")

        ttl = self._ttl_for_period(end)
        key = f"{account}#{start}#{end}#daily-svc"
        if not force:
            cached = self._costs.get_cost_cache(key)
            if cached:
                fetched_at = cached.get("fetchedAt", "")
                if self._fresh(fetched_at, ttl):
                    data = self._decode(cached.get("data") or {})
                    data["cached"] = True
                    data["fetchedAt"] = fetched_at
                    return data

        # Modo solo-caché: no hay dato fresco y no se debe gastar una consulta.
        if cached_only:
            return {"pending": True}

        client = self._ce_client(account)
        data = self._fetch_daily_by_service(client, start, end)
        data["account"] = account
        data["start"] = start
        data["end"] = end
        now = self._now()
        self._costs.put_cost_cache(key, self._encode(data), now)
        data["cached"] = False
        data["fetchedAt"] = now
        return data

    def _fetch_daily_by_service(self, client, start: str, end: str) -> dict[str, Any]:
        resp = client.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end}, Granularity="DAILY",
            Metrics=["UnblendedCost"],
            Filter={"Not": {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}}},
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        days = []
        for r in resp.get("ResultsByTime", []):
            date = r["TimePeriod"]["Start"]
            services = []
            total = 0.0
            for g in r.get("Groups", []):
                amount = float(g["Metrics"]["UnblendedCost"]["Amount"])
                total += amount
                if abs(amount) < 0.0001:
                    continue
                services.append({"service": g["Keys"][0], "amount": self._fmt(amount)})
            services.sort(key=lambda s: float(s["amount"]), reverse=True)
            days.append({"date": date, "total": self._fmt(total), "services": services})
        return {"days": days}

    def _fetch_service_detail(self, client, service: str, start: str, end: str) -> dict[str, Any]:
        resp = client.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end}, Granularity="MONTHLY",
            Metrics=["UnblendedCost", "UsageQuantity"],
            Filter={"And": [
                {"Dimensions": {"Key": "SERVICE", "Values": [service]}},
                {"Not": {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Credit", "Refund"]}}},
            ]},
            GroupBy=[{"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
        )
        items = []
        total = 0.0
        groups = resp["ResultsByTime"][0]["Groups"] if resp.get("ResultsByTime") else []
        for g in groups:
            amount = float(g["Metrics"]["UnblendedCost"]["Amount"])
            total += amount
            if abs(amount) < 0.0001:
                continue
            qty_metric = g.get("Metrics", {}).get("UsageQuantity", {})
            qty = qty_metric.get("Amount")
            items.append({
                "usageType": g["Keys"][0],
                "amount": self._fmt(amount),
                "quantity": self._fmt(float(qty)) if qty is not None else "",
                "unit": qty_metric.get("Unit", ""),
            })
        items.sort(key=lambda x: float(x["amount"]), reverse=True)
        return {"items": items[:25], "total": self._fmt(total)}

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

        # Tendencia diaria. Se agrupa por RECORD_TYPE en la MISMA llamada para
        # obtener neto (todo) y bruto (excluye créditos/reembolsos) sin costo extra.
        # En cuentas donde los créditos cubren el consumo, el neto es ~0 todos los
        # días (línea plana); el bruto sí refleja el consumo real.
        daily_resp = client.get_cost_and_usage(
            TimePeriod=period, Granularity="DAILY", Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "RECORD_TYPE"}],
        )
        daily = []
        daily_gross = []
        for r in daily_resp.get("ResultsByTime", []):
            date = r["TimePeriod"]["Start"]
            day_net = 0.0
            day_gross = 0.0
            for g in r.get("Groups", []):
                amount = float(g["Metrics"]["UnblendedCost"]["Amount"])
                day_net += amount
                if g["Keys"][0] not in ("Credit", "Refund"):
                    day_gross += amount
            daily.append({"date": date, "amount": self._fmt(day_net)})
            daily_gross.append({"date": date, "amount": self._fmt(day_gross)})

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
            "dailyGross": daily_gross,
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
