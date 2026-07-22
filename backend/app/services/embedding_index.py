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
NS_CATALOG_COL = "catalog-col"               # nivel 2: f"catalog-col:{cuenta}"

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


# ── Solicitudes (búsqueda avanzada: híbrida sobre solicitud + seguimiento) ───
# Devuelve solicitudes ranqueadas por relevancia. Busca en DOS namespaces y mapea
# cada acierto a su solicitud: un match en un SEGUIMIENTO surface su solicitud
# padre (lo que el keyword no cubre hoy — no busca en la bitácora). Marca "via"
# (solicitud|seguimiento) y, si fue por seguimiento, el updateId para que el
# frontend muestre el fragmento (ya tiene el texto de los seguimientos en memoria).
def workspace_semantic_search(query: str, top_k: int = 60,
                              min_score: float = 0.2) -> list[dict[str, Any]]:
    query = (query or "").strip()
    if not query:
        return []
    hits: dict[str, dict[str, Any]] = {}
    try:
        sidx = solicitud_index()
        uidx = seguimiento_index()
        for h in sidx.search(query, top_k=top_k, min_score=min_score):
            pid = (h.get("meta") or {}).get("projectId") or h.get("docId", "")
            if pid and h["score"] > hits.get(pid, {}).get("score", -1):
                hits[pid] = {"projectId": pid, "score": h["score"], "via": "solicitud", "updateId": ""}
        for h in uidx.search(query, top_k=top_k, min_score=min_score):
            meta = h.get("meta") or {}
            pid = meta.get("projectId", "")
            if not pid:
                continue
            if h["score"] > hits.get(pid, {}).get("score", -1):
                hits[pid] = {"projectId": pid, "score": h["score"], "via": "seguimiento",
                             "updateId": meta.get("updateId", "")}
    except Exception:                       # noqa: BLE001
        logger.warning("Búsqueda semántica de solicitudes falló", exc_info=True)
        return []
    ranked = list(hits.values())
    for r in ranked:
        r["score"] = round(float(r["score"]), 3)
    ranked.sort(key=lambda r: r["score"], reverse=True)
    return ranked[:top_k]


# ── Catálogo (búsqueda semántica de tablas, namespace por cuenta) ────────────
# DOS NIVELES (2026-07-16, "chunking" por unidad semántica — la columna):
#   catalog:<cuenta>      1 vector por TABLA — "¿de qué trata esta tabla?"
#                         (nombre + descripción + contexto funcional + NOMBRES de
#                         columnas con su comentario Glue; SIN las descripciones
#                         humanas de columnas, que viven en el nivel 2)
#   catalog-col:<cuenta>  1 vector por COLUMNA DOCUMENTADA — "¿dónde hay una
#                         columna que signifique X?" (docId <db>#<tabla>#<col>)
# Por qué: un solo vector por tabla ancha (190+ columnas documentadas) es el
# promedio de 190 conceptos → centroide difuso que diluye la señal de cada
# columna (además de rozar el límite de tokens de Titan). Trocear por columna es
# el mismo patrón seguimiento→solicitud: el acierto de columna surface su tabla.
# Solo columnas CON contexto humano tienen vector (los nombres pelones ya van en
# el vector de tabla); el índice crece con la documentación del diccionario.
def catalog_index(account: str) -> EmbeddingIndex:
    # Tope amplio para el documento de tabla: el límite real de Titan son ~8192
    # TOKENS (~25-30K chars en español); 20K chars deja margen. El warning de
    # abajo avisa antes de llegar.
    return EmbeddingIndex(EmbeddingConfig(
        table_name=os.environ["MAIN_TABLE_NAME"],
        namespace=f"{NS_CATALOG}:{account}",
        model_id=TITAN_MODEL, dimensions=DIMENSIONS, region=REGION,
        max_input_chars=20000,
        bedrock_session_provider=_hub_session, table_session_provider=None))


def catalog_col_index(account: str) -> EmbeddingIndex:
    return index_for(f"{NS_CATALOG_COL}:{account}")


def _catalog_doc_id(database: str, table: str) -> str:
    return f"{database}#{table}"


def catalog_table_text(table: dict[str, Any]) -> str:
    """Documento semántico de la TABLA (nivel 1): nombre + descripción Glue +
    contexto funcional + nombres de columnas con su comentario Glue. Las
    descripciones humanas de columnas NO van aquí (nivel 2, un vector por columna:
    evita diluir el vector de la tabla y el límite de tokens)."""
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
            bit += f" ({col['comment']})"                 # comentario Glue (corto)
        if bit:
            col_bits.append(bit)
    if col_bits:
        parts.append("Columnas: " + "; ".join(col_bits))
    return "\n".join(parts)


def catalog_column_text(col: dict[str, Any]) -> str:
    """Documento semántico de UNA columna (nivel 2). Vacío si no está documentada
    (sin contexto humano) — y vacío significa "sin vector" (el core lo borra)."""
    cc = col.get("context") or {}
    if not (cc.get("description") or cc.get("notes")):
        return ""
    parts = [col.get("name", "")]
    if col.get("comment"):
        parts.append(str(col["comment"]))
    if cc.get("description"):
        parts.append(str(cc["description"]))
    if cc.get("notes"):
        parts.append(str(cc["notes"]))
    return " — ".join(p for p in parts if p)


def catalog_snippet(table: dict[str, Any]) -> str:
    """Fragmento legible para mostrar en el resultado (sin abrir la tabla)."""
    ctx = table.get("context") or {}
    text = ctx.get("usagePrimary") or ctx.get("description") or table.get("description") or ""
    return str(text)[:160]


def safe_index_catalog_table(account: str, table_detail: dict[str, Any],
                             include_columns: bool = True) -> None:
    """Indexa el vector de la TABLA (nivel 1) y, si `include_columns`, los de sus
    COLUMNAS documentadas (nivel 2). Idempotente por hash en ambos niveles;
    columnas que dejan de estar documentadas pierden su vector (texto vacío →
    delete en el core). `include_columns=False` para ediciones que solo tocan el
    documento de la tabla (p. ej. guardar su contexto funcional) — editar UNA
    columna usa `safe_index_catalog_column` (no recorre las 190 restantes)."""
    db = table_detail.get("database", "")
    name = table_detail.get("name", "")
    if not db or not name:
        return
    try:
        text = catalog_table_text(table_detail)
        idx = catalog_index(account)
        if len(text) > int(idx._config.max_input_chars * 0.9):
            # Aviso ANTES de truncar: si esto aparece, la tabla roza el tope del
            # documento (subir max_input_chars o revisar el diseño de niveles).
            logger.warning("Documento de tabla %s.%s cerca del tope de embedding: %d/%d chars",
                           db, name, len(text), idx._config.max_input_chars)
        idx.index(
            _catalog_doc_id(db, name), text,
            meta={"account": account, "database": db, "table": name,
                  "snippet": catalog_snippet(table_detail)},
            updated_at=table_detail.get("syncedAt", ""))
    except Exception:                       # noqa: BLE001
        logger.warning("No se pudo indexar la tabla %s.%s (embedding)", db, name, exc_info=True)
    if not include_columns:
        return
    try:
        cidx = catalog_col_index(account)
        for col in table_detail.get("columns") or []:
            col_name = col.get("name", "")
            if not col_name:
                continue
            cidx.index(
                f"{db}#{name}#{col_name}", catalog_column_text(col),
                meta={"account": account, "database": db, "table": name,
                      "column": col_name,
                      "snippet": str((col.get("context") or {}).get("description") or "")[:160]},
                updated_at=table_detail.get("syncedAt", ""))
    except Exception:                       # noqa: BLE001
        logger.warning("No se pudieron indexar columnas de %s.%s", db, name, exc_info=True)


def safe_index_catalog_column(account: str, database: str, table: str,
                              col: dict[str, Any]) -> None:
    """Indexa/actualiza el vector de UNA columna (al guardar su contexto), sin
    recorrer las demás. `col` = {name, comment?, context{description, notes}}."""
    col_name = col.get("name", "")
    if not database or not table or not col_name:
        return
    try:
        catalog_col_index(account).index(
            f"{database}#{table}#{col_name}", catalog_column_text(col),
            meta={"account": account, "database": database, "table": table,
                  "column": col_name,
                  "snippet": str((col.get("context") or {}).get("description") or "")[:160]},
            updated_at="")
    except Exception:                       # noqa: BLE001
        logger.warning("No se pudo indexar la columna %s.%s.%s", database, table, col_name, exc_info=True)


def safe_delete_catalog(account: str, database: str, table: str,
                        columns: Optional[list[str]] = None) -> None:
    """Borra el vector de la tabla y (si se conocen) los de sus columnas."""
    if not database or not table:
        return
    try:
        catalog_index(account).delete(_catalog_doc_id(database, table))
        cidx = catalog_col_index(account)
        for col_name in columns or []:
            if col_name:
                cidx.delete(f"{database}#{table}#{col_name}")
    except Exception:                       # noqa: BLE001
        logger.warning("No se pudo borrar el vector de %s.%s", database, table, exc_info=True)


def catalog_search(account: str, query: str, top_k: int = 40,
                   min_score: float = 0.2) -> list[dict[str, Any]]:
    """Búsqueda en DOS niveles: tablas + columnas documentadas. Un acierto de
    columna surface su TABLA (meta trae `column` y su snippet, para que la UI
    muestre "≈ columna: X"). Si la misma tabla acierta por ambos niveles, gana el
    mejor score. Best-effort: si el índice/Titan falla devuelve vacío."""
    merged: dict[str, dict[str, Any]] = {}
    try:
        for h in catalog_index(account).search(query, top_k=top_k, min_score=min_score):
            meta = h.get("meta") or {}
            key = h.get("docId", "")
            if key and h["score"] > merged.get(key, {}).get("score", -1):
                merged[key] = {"docId": key, "score": h["score"], "meta": meta}
    except Exception:                       # noqa: BLE001
        logger.warning("Búsqueda semántica de catálogo (tablas) falló (cuenta %s)", account, exc_info=True)
    try:
        for h in catalog_col_index(account).search(query, top_k=top_k, min_score=min_score):
            meta = h.get("meta") or {}
            key = _catalog_doc_id(meta.get("database", ""), meta.get("table", ""))
            if key == "#":
                continue
            if h["score"] > merged.get(key, {}).get("score", -1):
                merged[key] = {"docId": key, "score": h["score"], "meta": meta}
    except Exception:                       # noqa: BLE001
        logger.warning("Búsqueda semántica de catálogo (columnas) falló (cuenta %s)", account, exc_info=True)
    ranked = sorted(merged.values(), key=lambda r: r["score"], reverse=True)
    return ranked[:top_k]


def catalog_backfill(account: str, max_workers: int = 8) -> dict[str, int]:
    """Indexa TODAS las tablas de una cuenta (idempotente por hash). Paraleliza el
    get_table+embed para caber en el timeout del Lambda con miles de tablas. Se
    dispara con la acción `catalog_embeddings_backfill` del handler."""
    from concurrent.futures import ThreadPoolExecutor

    from services.catalog import CatalogService
    svc = CatalogService(account)
    account_id = svc._account
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
            # Nivel 1 (tabla) + nivel 2 (columnas documentadas), idempotente.
            safe_index_catalog_table(account_id, detail, include_columns=True)
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
