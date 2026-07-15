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
from typing import Any, Optional

import boto3

from core.embeddings import EmbeddingConfig, EmbeddingIndex
from services.llm import HUB_ROLE_ARN, REGION

logger = logging.getLogger(__name__)

TITAN_MODEL = "amazon.titan-embed-text-v2:0"
DIMENSIONS = 256
NS_SOLICITUD = "solicitud"
NS_SEGUIMIENTO = "seguimiento"


def _hub_session() -> "boto3.Session":
    """Sesión con el rol del hub (donde vive Bedrock/Titan). Igual que
    LlmService._session, pero con su propio RoleSessionName."""
    creds = boto3.client("sts").assume_role(
        RoleArn=HUB_ROLE_ARN, RoleSessionName="gp-embed")["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"], region_name=REGION)


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
