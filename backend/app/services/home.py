import json
import os
import re
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

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

# Acciones de CloudTrail que generan costo, por servicio. Atribución forense del
# "quién" de un pico (acciones de management; los data events no se registran por
# defecto). Cada acción se consulta por separado (LookupEvents acepta 1 atributo).
SERVICE_EVENTS = {
    "Amazon SageMaker": [
        "CreateApp", "CreateProcessingJob", "CreateTrainingJob", "CreateTransformJob",
        "CreateHyperParameterTuningJob", "StartPipelineExecution",
        "CreateEndpoint", "CreateNotebookInstance",
    ],
}


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

    def _client(self, account: str, service: str):
        """Cliente boto3 del servicio en la cuenta indicada. mode 'direct' usa el
        rol de la Lambda; mode 'assume' asume el rol cross-account de esa cuenta.
        Sirve para 'ce' (Cost Explorer) y 'cloudtrail' (responsables)."""
        cfg = COST_ACCOUNTS.get(account)
        if not cfg:
            raise ValidationError("Cuenta no permitida.")
        if cfg.get("mode") == "direct":
            return boto3.client(service, region_name="us-east-1")
        role_arn = cfg.get("roleArn")
        if not role_arn:
            raise ValidationError("Cuenta sin rol cross-account configurado.")
        creds = boto3.client("sts").assume_role(
            RoleArn=role_arn,
            RoleSessionName="gestion-proyectos-costs",
        )["Credentials"]
        return boto3.client(
            service, region_name="us-east-1",
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )

    def _ce_client(self, account: str):
        return self._client(account, "ce")

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

    # ── Consumo de modelos LLM (Bedrock / Mantle) ────────────────────────────
    # El USO (invocaciones + tokens) se mide en CloudWatch, namespace
    # AWS/BedrockMantle (métricas Inferences, TotalInputTokens, TotalOutputTokens;
    # dimensión Model). Vive por cuenta: cada cuenta lee SU propio CloudWatch
    # (mismo rol cross-account que Cost Explorer); sin modelos devuelve vacío.
    # Hallado en el proyecto hermano Agente_Mantenimiento (docs/01 de ese repo).
    #
    # El COSTO REAL por modelo SÍ está en Cost Explorer (hallazgo del usuario
    # 2026-07-14 en la consola Bills del hub): cada modelo es un servicio de
    # Marketplace ("Claude Opus 4.7 (Amazon Bedrock Edition)", etc.) con un cargo
    # RECORD_TYPE=Usage al precio facturado, neteado por un Credit idéntico
    # ("Banrural Datawarehouse PhaseII") — por eso el costo NETO por servicio da
    # $0.00 y antes creíamos que no había dato. Filtrando Usage se obtiene la
    # cifra real; quien la paga de verdad es la cuenta pagadora de la org
    # (866174429827, vía GBM).
    #
    # El Bedrock CLÁSICO (GLM 5, gpt-oss-120b…) factura distinto: un solo
    # servicio "Amazon Bedrock" (BILLING_ENTITY=AWS), también neteado por
    # crédito, y el desglose por modelo viene en USAGE_TYPE
    # ("USE1-zai.glm-5-input-tokens"…). Su uso se mide en CloudWatch
    # AWS/Bedrock (Invocations, InputTokenCount, OutputTokenCount; dimensión
    # ModelId). Ambas familias se funden en la misma tabla de consumo.
    _MANTLE_NAMESPACE = "AWS/BedrockMantle"
    _BEDROCK_NAMESPACE = "AWS/Bedrock"

    # Precios de REFERENCIA por millón de tokens (entrada, salida) en USD —
    # FALLBACK cuando Cost Explorer aún no refleja el cargo real de un modelo.
    # OJO: sobreestiman, porque TotalInputTokens de CloudWatch incluye tokens de
    # caché (facturados a ~10% del precio de entrada). El dato bueno es el real.
    _LLM_REF_PRICES_USD_MTOK = {
        "anthropic.claude-haiku-4-5": (1.0, 5.0),
        "anthropic.claude-opus-4-7": (5.0, 25.0),
        "anthropic.claude-opus-4-8": (5.0, 25.0),
    }

    def get_llm_consumption(self, account: str, start: str, end: str, force: bool = False) -> dict[str, Any]:
        account = (account or "").strip()
        if account not in COST_ACCOUNTS:
            raise ValidationError("Cuenta no permitida.")
        self._validate_date(start, "inicio")
        self._validate_date(end, "fin")

        ttl = self._ttl_for_period(end)
        key = f"{account}#{start}#{end}#llm-mantle"
        if not force:
            cached = self._costs.get_cost_cache(key)
            if cached:
                fetched_at = cached.get("fetchedAt", "")
                if self._fresh(fetched_at, ttl):
                    data = self._decode(cached.get("data") or {})
                    data["cached"] = True
                    data["fetchedAt"] = fetched_at
                    return data

        try:
            client = self._client(account, "cloudwatch")
            real_costs = self._fetch_llm_real_costs(account, start, end)
            classic_costs = self._fetch_bedrock_real_costs(account, start, end)
            data = self._fetch_llm_consumption(client, start, end, real_costs, classic_costs)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            # El rol de la cuenta aún no tiene el permiso de CloudWatch (grant
            # manual pendiente): se reporta sin romper la vista de costos.
            if code in ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation"):
                return {"available": False, "reason": "forbidden", "models": [],
                        "account": account, "cached": False, "fetchedAt": self._now()}
            raise

        data["account"] = account
        data["start"] = start
        data["end"] = end
        now = self._now()
        self._costs.put_cost_cache(key, self._encode(data), now)
        data["cached"] = False
        data["fetchedAt"] = now
        return data

    @staticmethod
    def _norm_model_key(name: str) -> str:
        """Normaliza para casar el servicio de CE ("Claude Opus 4.7 (Amazon
        Bedrock Edition)") con el modelo de CloudWatch ("anthropic.claude-opus-4-7"):
        minúsculas y solo alfanuméricos de la parte antes del paréntesis."""
        base = name.split("(")[0].lower()
        return "".join(ch for ch in base if ch.isalnum())

    def _fetch_llm_real_costs(self, account: str, start: str, end: str) -> dict[str, float]:
        """Costo REAL de uso por modelo (Cost Explorer): cargos de Marketplace
        (BILLING_ENTITY='AWS Marketplace') con RECORD_TYPE='Usage' — la cifra
        facturada del consumo, ANTES del crédito que la netea a $0 en la cuenta.
        Best-effort: si CE falla se devuelve vacío y la UI cae al estimado."""
        try:
            resp = self._ce_client(account).get_cost_and_usage(
                TimePeriod={"Start": start, "End": end},
                Granularity="MONTHLY", Metrics=["UnblendedCost"],
                GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
                Filter={"And": [
                    {"Dimensions": {"Key": "BILLING_ENTITY", "Values": ["AWS Marketplace"]}},
                    {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}},
                ]},
            )
        except ClientError:
            return {}
        out: dict[str, float] = {}
        for period in resp.get("ResultsByTime", []):
            for g in period.get("Groups", []):
                svc = g.get("Keys", [""])[0]
                amt = float(g.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", 0) or 0)
                key = self._norm_model_key(svc)
                if key:
                    out[key] = out.get(key, 0.0) + amt
        return out

    def _fetch_bedrock_real_costs(self, account: str, start: str, end: str) -> dict[str, float]:
        """Costo REAL de uso por modelo del Bedrock CLÁSICO: el servicio
        "Amazon Bedrock" con RECORD_TYPE='Usage', desglosado por USAGE_TYPE
        ("USE1-zai.glm-5-input-tokens"…). Se quita el prefijo de región y el
        sufijo de tokens y se agregan entrada+salida+caché por modelo.
        Best-effort: vacío si CE falla (las filas quedan sin realUsd)."""
        try:
            resp = self._ce_client(account).get_cost_and_usage(
                TimePeriod={"Start": start, "End": end},
                Granularity="MONTHLY", Metrics=["UnblendedCost"],
                GroupBy=[{"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
                Filter={"And": [
                    {"Dimensions": {"Key": "SERVICE", "Values": ["Amazon Bedrock"]}},
                    {"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}},
                ]},
            )
        except ClientError:
            return {}
        out: dict[str, float] = {}
        for period in resp.get("ResultsByTime", []):
            for g in period.get("Groups", []):
                usage = g.get("Keys", [""])[0]
                amt = float(g.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", 0) or 0)
                base = re.sub(r"^[A-Z]{2,5}\d?-", "", usage)          # USE1-, EUW1-…
                base = re.sub(r"-(input|output|cache[a-z0-9-]*)-tokens$", "", base, flags=re.I)
                key = self._norm_model_key(base)
                if key:
                    out[key] = out.get(key, 0.0) + amt
        return out

    def _fetch_bedrock_classic_rows(self, client, start_dt, end_dt,
                                    costs: dict[str, float] | None) -> list[dict[str, Any]]:
        """Filas de consumo del Bedrock clásico: modelos con métricas en la
        ventana (AWS/Bedrock, dimensión ModelId) leídos con UNA llamada
        GetMetricData (son decenas de modelos; llamarlos de a uno no escala).
        Si CE respondió, todo modelo tiene costo real (ausente = $0 facturado);
        si CE falló, las filas van sin realUsd y la UI muestra "—"."""
        metrics = client.list_metrics(
            Namespace=self._BEDROCK_NAMESPACE, MetricName="Invocations").get("Metrics", [])
        models = sorted({
            d["Value"] for m in metrics for d in m.get("Dimensions", [])
            if d.get("Name") == "ModelId"
        })
        if not models:
            return []
        names = ("Invocations", "InputTokenCount", "OutputTokenCount")
        queries = [
            {"Id": f"m{i}_{j}", "MetricStat": {
                "Metric": {"Namespace": self._BEDROCK_NAMESPACE, "MetricName": name,
                           "Dimensions": [{"Name": "ModelId", "Value": model}]},
                "Period": 86400, "Stat": "Sum"}}
            for i, model in enumerate(models) for j, name in enumerate(names)
        ]
        sums: dict[str, float] = {}
        for i in range(0, len(queries), 500):    # tope de GetMetricData: 500 queries
            token = None
            while True:
                kwargs = {"MetricDataQueries": queries[i:i + 500],
                          "StartTime": start_dt, "EndTime": end_dt}
                if token:
                    kwargs["NextToken"] = token
                resp = client.get_metric_data(**kwargs)
                for r in resp.get("MetricDataResults", []):
                    sums[r["Id"]] = sums.get(r["Id"], 0.0) + sum(r.get("Values", []))
                token = resp.get("NextToken")
                if not token:
                    break
        costs = costs or {}
        rows = []
        for i, model in enumerate(models):
            inv, tin, tout = (sums.get(f"m{i}_{j}", 0.0) for j in range(3))
            if inv == 0 and tin == 0 and tout == 0:
                continue
            model_key = self._norm_model_key(model)
            # Exacto primero (evita que "minimax-m2" capture el cargo de
            # "minimax-m2.5"); contención como red para nombres divergentes
            # ("MistralLarge" ↔ "mistral.mistral-large-2402-v1:0").
            real = costs.get(model_key)
            if real is None:
                real = next((v for k, v in costs.items()
                             if k and (k in model_key or model_key in k)), None)
            if real is None and costs:
                real = 0.0
            rows.append({
                "model": model,
                "invocations": str(int(inv)),
                "inputTokens": str(int(tin)),
                "outputTokens": str(int(tout)),
                "estimatedUsd": "",
                "realUsd": f"{real:.2f}" if real is not None else "",
                "_real": real, "_tokens": tin + tout,
            })
        # El hub acumula decenas de modelos "estrenados" con 1-2 invocaciones de
        # prueba: colapsarlos en una fila para que no ahoguen el consumo real.
        keep = [r for r in rows if (r["_real"] or 0) >= 0.01 or r["_tokens"] >= 10_000]
        rest = [r for r in rows if r not in keep]
        for r in keep:
            r.pop("_real"), r.pop("_tokens")
        if rest:
            has_costs = bool(costs)
            keep.append({
                "model": f"(otros: {len(rest)} modelos con pruebas puntuales)",
                "invocations": str(sum(int(r["invocations"]) for r in rest)),
                "inputTokens": str(sum(int(r["inputTokens"]) for r in rest)),
                "outputTokens": str(sum(int(r["outputTokens"]) for r in rest)),
                "estimatedUsd": "",
                "realUsd": f"{sum(r['_real'] or 0 for r in rest):.2f}" if has_costs else "",
            })
        return keep

    def _fetch_llm_consumption(self, client, start: str, end: str,
                               real_costs: dict[str, float] | None = None,
                               classic_costs: dict[str, float] | None = None) -> dict[str, Any]:
        start_dt = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end_dt = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        # Modelos con métricas en la ventana (dimensión Model de la métrica base).
        metrics = client.list_metrics(
            Namespace=self._MANTLE_NAMESPACE, MetricName="Inferences").get("Metrics", [])
        models = sorted({
            d["Value"] for m in metrics for d in m.get("Dimensions", [])
            if d.get("Name") == "Model"
        })
        real_costs = real_costs or {}
        rows = []
        tot_inv = tot_in = tot_out = tot_usd = 0.0
        tot_real = 0.0
        for model in models:
            inv = self._sum_mantle_metric(client, "Inferences", model, start_dt, end_dt)
            tin = self._sum_mantle_metric(client, "TotalInputTokens", model, start_dt, end_dt)
            tout = self._sum_mantle_metric(client, "TotalOutputTokens", model, start_dt, end_dt)
            if inv == 0 and tin == 0 and tout == 0:
                continue
            # Costo REAL (CE Marketplace Usage) si existe; casa por nombre
            # normalizado ("claudeopus47" ⊂ "anthropicclaudeopus47").
            model_key = self._norm_model_key(model.replace(".", " ").replace("-", " "))
            real = next((v for k, v in real_costs.items()
                         if k and (k in model_key or model_key in k)), None)
            real_usd = ""
            if real is not None:
                tot_real += real
                real_usd = f"{real:.2f}"
            # Estimación (fallback): tokens × precio de referencia. Sin precio →
            # "" (la UI muestra "—"); nunca se inventa una tarifa.
            price = self._LLM_REF_PRICES_USD_MTOK.get(model)
            usd = ""
            if price:
                est = (tin / 1_000_000) * price[0] + (tout / 1_000_000) * price[1]
                tot_usd += est
                usd = f"{est:.2f}"
            rows.append({
                "model": model,
                # Cifras como string (convención de caché: DynamoDB sin floats).
                "invocations": str(int(inv)),
                "inputTokens": str(int(tin)),
                "outputTokens": str(int(tout)),
                "estimatedUsd": usd,
                "realUsd": real_usd,
            })
            tot_inv += inv
            tot_in += tin
            tot_out += tout
        for row in self._fetch_bedrock_classic_rows(client, start_dt, end_dt, classic_costs):
            if row["realUsd"]:
                tot_real += float(row["realUsd"])
            tot_inv += int(row["invocations"])
            tot_in += int(row["inputTokens"])
            tot_out += int(row["outputTokens"])
            rows.append(row)
        all_real = bool(rows) and all(r["realUsd"] for r in rows)
        # El costo manda en el orden (es la vista de facturación); a igual costo,
        # por invocaciones.
        rows.sort(key=lambda r: (float(r["realUsd"] or 0), int(r["invocations"])), reverse=True)
        return {
            "available": True,
            "models": rows,
            "totals": {
                "invocations": str(int(tot_inv)),
                "inputTokens": str(int(tot_in)),
                "outputTokens": str(int(tot_out)),
                "estimatedUsd": f"{tot_usd:.2f}",
                "realUsd": f"{tot_real:.2f}" if all_real else "",
            },
        }

    def _sum_mantle_metric(self, client, metric: str, model: str, start_dt, end_dt) -> float:
        resp = client.get_metric_statistics(
            Namespace=self._MANTLE_NAMESPACE, MetricName=metric,
            Dimensions=[{"Name": "Model", "Value": model}],
            StartTime=start_dt, EndTime=end_dt, Period=86400, Statistics=["Sum"],
        )
        return sum(p.get("Sum", 0) for p in resp.get("Datapoints", []))

    # ── Responsables (CloudTrail): el "quién" forense de un pico ──────────────
    def get_responsibles(self, account: str, service: str, start: str, end: str,
                         force: bool = False) -> dict[str, Any]:
        """Quién lanzó las acciones que generan costo de un servicio en el rango
        (vía CloudTrail LookupEvents, retroactivo 90 días, sin depender de tags).
        Devuelve actores agregados. Atribuye por ACCIÓN, no por dólar."""
        account = (account or "").strip()
        service = (service or "").strip()
        if account not in COST_ACCOUNTS:
            raise ValidationError("Cuenta no permitida.")
        self._validate_date(start, "inicio")
        self._validate_date(end, "fin")

        events = SERVICE_EVENTS.get(service)
        if not events:
            return {"supported": False, "service": service, "actors": [], "cached": False}

        ttl = self._ttl_for_period(end)
        key = f"{account}#{start}#{end}#resp#{service}"
        if not force:
            cached = self._costs.get_cost_cache(key)
            if cached:
                fetched_at = cached.get("fetchedAt", "")
                if self._fresh(fetched_at, ttl):
                    data = self._decode(cached.get("data") or {})
                    data["cached"] = True
                    data["fetchedAt"] = fetched_at
                    return data

        client = self._client(account, "cloudtrail")
        data = self._fetch_responsibles(client, events, start, end)
        data["supported"] = True
        data["service"] = service
        data["account"] = account
        now = self._now()
        self._costs.put_cost_cache(key, self._encode(data), now)
        data["cached"] = False
        data["fetchedAt"] = now
        return data

    def _fetch_responsibles(self, client, events: list[str], start: str, end: str) -> dict[str, Any]:
        start_dt = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end_dt = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        actors: dict[str, dict[str, Any]] = {}
        for name in events:
            token = None
            pages = 0
            while True:
                kwargs = {
                    "LookupAttributes": [{"AttributeKey": "EventName", "AttributeValue": name}],
                    "StartTime": start_dt, "EndTime": end_dt, "MaxResults": 50,
                }
                if token:
                    kwargs["NextToken"] = token
                try:
                    resp = client.lookup_events(**kwargs)
                except Exception:
                    break
                for ev in resp.get("Events", []):
                    actor, instance = self._parse_event(ev)
                    entry = actors.setdefault(actor, {"actor": actor, "count": 0, "actions": {}, "instances": {}})
                    entry["count"] += 1
                    entry["actions"][name] = entry["actions"].get(name, 0) + 1
                    if instance:
                        entry["instances"][instance] = entry["instances"].get(instance, 0) + 1
                token = resp.get("NextToken")
                pages += 1
                if not token or pages >= 10:
                    break
        result = sorted(actors.values(), key=lambda a: a["count"], reverse=True)
        # Convierte los dicts de actions/instances a listas legibles.
        for a in result:
            a["actions"] = [{"action": k, "count": v} for k, v in sorted(a["actions"].items(), key=lambda x: -x[1])]
            a["instances"] = [k for k, _ in sorted(a["instances"].items(), key=lambda x: -x[1])]
        return {"actors": result}

    def _parse_event(self, ev: dict[str, Any]) -> tuple[str, str]:
        import json as _json
        try:
            raw = _json.loads(ev.get("CloudTrailEvent", "{}"))
        except (ValueError, TypeError):
            raw = {}
        rp = raw.get("requestParameters") or {}
        ident = raw.get("userIdentity") or {}
        # Mejor identificador disponible: user-profile de Studio > nombre IAM >
        # sesión del rol asumido > tipo.
        actor = (
            rp.get("userProfileName")
            or ident.get("userName")
            or (ident.get("arn", "") or "").split("/")[-1]
            or ident.get("type")
            or "desconocido"
        )
        # Tipo de instancia si aparece en el request (apps/jobs).
        instance = (
            (rp.get("resourceSpec") or {}).get("instanceType")
            or ((rp.get("processingResources") or {}).get("clusterConfig") or {}).get("instanceType")
            or (rp.get("resourceConfig") or {}).get("instanceType")
            or ""
        )
        return actor, instance

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
            # Lista COMPLETA (antes top-10): el "Detalle por servicio" debe
            # espejear Cost Explorer — con el corte, servicios reales (GPT-5.5,
            # Amazon Bedrock) eran invisibles y el buscador no los encontraba
            # (solo filtra filas renderizadas). Duda del usuario 2026-07-14.
            "byService": by_service,
            "grossByService": gross_by_service,
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
