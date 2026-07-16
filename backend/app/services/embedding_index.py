"""Cableado del índice de embeddings a ESTE proyecto (lo específico del dominio).

El core genérico (`core/embeddings.py`) no sabe de solicitudes ni de hubs; aquí se
le inyecta: la tabla del proyecto, el modelo Titan, y el proveedor de sesión que
asume el rol del hub para invocar Bedrock (mismo patrón que LlmService). La tabla
DynamoDB usa las credenciales del entorno (la cuenta de la app) — por eso los dos
proveedores del config son independientes.

Namespaces del proyecto: "solicitud" (nombre + descripción) y "seguimiento" (texto
de la bitácora). Cada uno es un segmento aislado en la misma tabla. Un módulo nuevo
(p. ej. Catálogo) sería un namespace más; una plataforma hermana copia el core y
cambia el `table_name`.

Todas las operaciones de indexado son BEST-EFFORT: si Titan o el hub fallan, el
guardado del dato NO se rompe (se registra y el vector queda pendiente; la búsqueda
lo autorepara al detectar que falta). Nunca lanzan hacia arriba.
"""
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import boto3

from core.embeddings import EmbeddingConfig, EmbeddingIndex
from services.llm import HUB_ROLE_ARN, REGION

logger = logging.getLogger(__name__)

TITAN_MODEL = "amazon.titan-embed-text-v2:0"
DIMENSIONS = 256
NS_SOLICITUD = "solicitud"
NS_SEGUIMIENTO = "seguimiento"
NS_CATALOG = "catalog"                       # namespace real = f"catalog:{cuenta}"

# Caché de la sesión del hub entre invocaciones calientes: sin esto, indexar en
# lote (backfill de miles de tablas) dispararía un assume-role por vector. Las
# credenciales STS son de corta vida; se refrescan al acercarse su expiración.
_HUB_SESSION: dict[str, Any] = {"session": None, "exp": None}


def _hub_session() -> "boto3.Session":
    """Sesión con el rol del hub (donde vive Bedrock/Titan). Cacheada hasta ~5 min
    antes de que expiren las credenciales."""
    now = datetime.now(timezone.utc)
    cache = _HUB_SESSION
    if cache["session"] is not None and cache["exp"] is not None and now < cache["exp"]:
        return cache["session"]
    creds = boto3.client("sts").assume_role(
        RoleArn=HUB_ROLE_ARN, RoleSessionName="gp-embed")["Credentials"]
    session = boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"], region_name=REGION)
    exp = creds.get("Expiration")
    cache["session"] = session
    cache["exp"] = (exp - timedelta(minutes=5)) if exp else (now + timedelta(minutes=45))
    return session


def index_for(namespace: str) -> EmbeddingIndex:
    return EmbeddingIndex(EmbeddingConfig(
        table_name=os.environ["MAIN_TABLE_NAME"],
        namespace=namespace,
        model_id=TITAN_MODEL,
        dimensions=DIMENSIONS,
        region=REGION,
        bedrock_session_provider=_hub_session,   # Bedrock via hub (assume-role)
        table_session_provider=None,             # tabla = credenciales de la app
    ))


def solicitud_index() -> EmbeddingIndex:
    return index_for(NS_SOLICITUD)


def seguimiento_index() -> EmbeddingIndex:
    return index_for(NS_SEGUIMIENTO)


# ── Texto indexable por dominio (qué se convierte en vector) ─────────────────
def solicitud_text(project: dict[str, Any]) -> str:
    """Nombre + descripción de la solicitud: el "de qué trata" para lo semántico."""
    parts = [project.get("name") or "", project.get("description") or ""]
    return " — ".join(p.strip() for p in parts if p.strip())


def seguimiento_text(update: dict[str, Any]) -> str:
    """El texto de la bitácora es la evidencia de "qué se hizo"."""
    return (update.get("text") or "").strip()


# ── Helpers best-effort (los llaman los servicios de dominio en sus writes) ──
def safe_index_solicitud(project: dict[str, Any]) -> None:
    pid = project.get("id") or project.get("projectId") or ""
    if not pid:
        return
    try:
        solicitud_index().index(
            pid, solicitud_text(project),
            meta={"projectId": pid, "name": (project.get("name") or "")[:80]},
            updated_at=project.get("updatedAt", ""))
    except Exception:                       # noqa: BLE001 — best-effort, no romper el write
        logger.warning("No se pudo indexar la solicitud %s (embedding)", pid, exc_info=True)


def safe_index_seguimiento(update: dict[str, Any]) -> None:
    # Acepta el item crudo (updateId) o el normalizado (id).
    uid = update.get("updateId") or update.get("id") or ""
    if not uid:
        return
    try:
        seguimiento_index().index(
            uid, seguimiento_text(update),
            meta={"updateId": uid, "projectId": update.get("projectId", ""),
                  "date": update.get("date", ""), "author": update.get("createdBy", "")},
            updated_at=update.get("updatedAt", ""))
    except Exception:                       # noqa: BLE001
        logger.warning("No se pudo indexar el seguimiento %s (embedding)", uid, exc_info=True)


def safe_delete(namespace: str, doc_id: str) -> None:
    if not doc_id:
        return
    try:
        index_for(namespace).delete(doc_id)
    except Exception:                       # noqa: BLE001
        logger.warning("No se pudo borrar el vector %s/%s", namespace, doc_id, exc_info=True)


def backfill_all() -> dict[str, int]:
    """Indexa TODO lo existente (solicitudes + seguimientos). Idempotente: el
    índice omite lo que no cambió (hash), así que re-ejecutarlo es seguro y barato.
    Import diferido de WorkspaceService para no acoplar el core ni arriesgar ciclos.
    Se dispara con la acción `embeddings_backfill` del handler (self-invoke)."""
    from services.workspace import WorkspaceService
    sidx = solicitud_index()
    uidx = seguimiento_index()
    ws = WorkspaceService().get_workspace()
    stats = {"solicitudes": 0, "seguimientos": 0, "errores": 0}
    for p in ws.get("projects", []):
        pid = p.get("id", "")
        try:
            sidx.index(pid, solicitud_text(p),
                       meta={"projectId": pid, "name": (p.get("name") or "")[:80]},
                       updated_at=p.get("updatedAt", ""))
            stats["solicitudes"] += 1
        except Exception:                   # noqa: BLE001
            stats["errores"] += 1
            logger.warning("Backfill: falló solicitud %s", pid, exc_info=True)
        for u in p.get("updates") or []:
            uid = u.get("id") or u.get("updateId") or ""
            try:
                uidx.index(uid, seguimiento_text(u),
                           meta={"updateId": uid, "projectId": pid,
                                 "date": u.get("date", ""), "author": u.get("createdBy", "")},
                           updated_at=u.get("updatedAt", ""))
                stats["seguimientos"] += 1
            except Exception:               # noqa: BLE001
                stats["errores"] += 1
                logger.warning("Backfill: falló seguimiento %s", uid, exc_info=True)
    logger.info("Backfill embeddings: %s", stats)
    return stats


# ── Catálogo (búsqueda semántica de tablas, namespace por cuenta) ────────────
# El namespace lleva la cuenta (`catalog:<cuenta>`) para que el barrido de coseno
# quede acotado a esa cuenta y no mezcle catálogos de cuentas distintas. docId =
# "<db>#<tabla>". El texto vectorizado incluye TODO lo semántico de la tabla:
# nombre + descripción de Glue + contexto funcional + nombres/comentarios de
# columnas + descripción humana de columnas — así "fecha de corte" encuentra la
# tabla cuya columna se llama/describe "cutoff".
def catalog_index(account: str) -> EmbeddingIndex:
    return index_for(f"{NS_CATALOG}:{account}")


def _catalog_doc_id(database: str, table: str) -> str:
    return f"{database}#{table}"


def catalog_table_text(table: dict[str, Any]) -> str:
    """Documento semántico de una tabla, a partir del detalle completo
    (`CatalogService.get_table`: name, description Glue, context{...}, columns con
    su context)."""
    parts: list[str] = []
    name = table.get("name") or ""
    if name:
        parts.append(name)
    if table.get("description"):
        parts.append(str(table["description"]))          # descripción de Glue
    ctx = table.get("context") or {}
    for field in ("description", "usagePrimary", "domain", "usageNotes"):
        if ctx.get(field):
            parts.append(str(ctx[field]))                 # contexto funcional humano
    col_bits: list[str] = []
    for col in table.get("columns") or []:
        bit = col.get("name", "")
        if col.get("comment"):
            bit += f" ({col['comment']})"                 # comentario Glue de la columna
        cc = col.get("context") or {}
        for field in ("description", "notes"):
            if cc.get(field):
                bit += f" — {cc[field]}"                   # descripción humana de la columna
        if bit:
            col_bits.append(bit)
    if col_bits:
        parts.append("Columnas: " + "; ".join(col_bits))
    return "\n".join(parts)


def catalog_snippet(table: dict[str, Any]) -> str:
    """Fragmento legible para mostrar en el resultado (sin abrir la tabla)."""
    ctx = table.get("context") or {}
    text = ctx.get("usagePrimary") or ctx.get("description") or table.get("description") or ""
    return str(text)[:160]


def safe_index_catalog_table(account: str, table_detail: dict[str, Any]) -> None:
    db = table_detail.get("database", "")
    name = table_detail.get("name", "")
    if not db or not name:
        return
    try:
        catalog_index(account).index(
            _catalog_doc_id(db, name), catalog_table_text(table_detail),
            meta={"account": account, "database": db, "table": name,
                  "snippet": catalog_snippet(table_detail)},
            updated_at=table_detail.get("syncedAt", ""))
    except Exception:                       # noqa: BLE001
        logger.warning("No se pudo indexar la tabla %s.%s (embedding)", db, name, exc_info=True)


def safe_delete_catalog(account: str, database: str, table: str) -> None:
    if not database or not table:
        return
    try:
        catalog_index(account).delete(_catalog_doc_id(database, table))
    except Exception:                       # noqa: BLE001
        logger.warning("No se pudo borrar el vector de %s.%s", database, table, exc_info=True)


def catalog_search(account: str, query: str, top_k: int = 40,
                   min_score: float = 0.2) -> list[dict[str, Any]]:
    """Best-effort: si el índice/Titan falla devuelve vacío (el endpoint degrada)."""
    try:
        return catalog_index(account).search(query, top_k=top_k, min_score=min_score)
    except Exception:                       # noqa: BLE001
        logger.warning("Búsqueda semántica de catálogo falló (cuenta %s)", account, exc_info=True)
        return []


def catalog_backfill(account: str, max_workers: int = 8) -> dict[str, int]:
    """Indexa TODAS las tablas de una cuenta (idempotente por hash). Paraleliza el
    get_table+embed para caber en el timeout del Lambda con miles de tablas. Se
    dispara con la acción `catalog_embeddings_backfill` del handler."""
    from concurrent.futures import ThreadPoolExecutor

    from services.catalog import CatalogService
    svc = CatalogService(account)
    account_id = svc._account
    idx = catalog_index(account_id)
    stats = {"tablas": 0, "errores": 0}

    pairs: list[tuple[str, str]] = []
    for d in svc.list_databases().get("databases", []):
        database = d.get("name") or d.get("database") or ""
        if not database:
            continue
        for t in svc.list_tables(database):
            pairs.append((database, t["name"]))

    def _one(pair: tuple[str, str]) -> bool:
        database, table = pair
        try:
            detail = svc.get_table(database, table)
            idx.index(_catalog_doc_id(database, table), catalog_table_text(detail),
                      meta={"account": account_id, "database": database, "table": table,
                            "snippet": catalog_snippet(detail)},
                      updated_at=detail.get("syncedAt", ""))
            return True
        except Exception:                   # noqa: BLE001
            logger.warning("Backfill catálogo: falló %s.%s", database, table, exc_info=True)
            return False

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        for ok in pool.map(_one, pairs):
            stats["tablas" if ok else "errores"] += 1
    stats["total"] = len(pairs)
    logger.info("Backfill catálogo (%s): %s", account_id, stats)
    return stats
