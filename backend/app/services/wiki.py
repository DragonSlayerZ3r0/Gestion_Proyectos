"""Wiki interna: base de conocimiento tipo Wikipedia.

Permisos (dos niveles, ver manifest.py):
  - LEER    → módulo `wiki` asignado (guard en las rutas GET).
  - ESCRIBIR→ sub-permiso `wiki_editor` (check hijo en Administración; guard en
              POST/PATCH/DELETE). El backend es la autoridad — el frontend solo
              oculta botones.

Contenido: markdown (lo renderiza el frontend con mdLite, el mismo del chat y
el reporte ejecutivo). Cada edición guarda el estado ANTERIOR como revisión
append-only (historial estilo wiki); las revisiones se borran junto con la
página. El cuerpo vive en el item (tope defensivo bajo los 400 KB de DynamoDB).
"""
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import boto3
from botocore.config import Config

from core.errors import ValidationError
from repositories.wiki import WikiRepository
from services.name_directory import NameDirectory

TITLE_MAX = 200
BODY_MAX = 150_000        # chars — margen amplio bajo el tope de 400 KB del item

# ── Imágenes pegadas (Ctrl+V) en el editor ───────────────────────────────────
# El binario va al bucket compartido de adjuntos (gad-storage, mismo prefijo de
# la app → el IAM de la Lambda ya lo cubre), bajo wiki/img/. En el markdown se
# referencia con el token `wikiimg:<uuid>.<ext>`; al VER la página, el frontend
# pide una URL presignada de lectura por token. El patrón es el de adjuntos:
# presign → PUT directo del navegador (el binario nunca pasa por la API).
_IMG_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
_IMG_MAX_BYTES = 5 * 1024 * 1024
_IMG_TOKEN_RE = re.compile(r"^[a-f0-9]{32}\.(png|jpg|webp|gif)$")
# Tokens dentro del markdown (para borrar los objetos al eliminar la página).
_IMG_IN_BODY_RE = re.compile(r"wikiimg:([a-f0-9]{32}\.(?:png|jpg|webp|gif))")
_PRESIGN_PUT_TTL = 300
_PRESIGN_GET_TTL = 900
_REGION = os.environ.get("AWS_REGION", "us-east-1")

# Limpieza de imágenes HUÉRFANAS (pegadas pero nunca guardadas, o quitadas del
# texto sin que ninguna revisión las use). Se dispara sola al guardar/borrar
# páginas, a lo sumo una vez cada _CLEANUP_INTERVAL (marcador en Dynamo), como
# self-invoke asíncrono para no sumar latencia al guardado. Gracia de
# _ORPHAN_MIN_AGE: una imagen recién subida en un editor ABIERTO aún no está en
# ningún body — sin la gracia se borraría antes de guardar.
_CLEANUP_INTERVAL = timedelta(hours=24)
_ORPHAN_MIN_AGE = timedelta(hours=24)

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class WikiService:
    def __init__(self, repository: WikiRepository | None = None) -> None:
        self._db = repository or WikiRepository()

    # ── Lectura ───────────────────────────────────────────────────────────────
    def list_pages(self) -> dict[str, Any]:
        """Listado liviano (sin cuerpo) para el sidebar; orden alfabético."""
        pages = [self._meta(i) for i in self._db.list_pages()]
        self._attach_names(pages)
        return {"pages": sorted(pages, key=lambda p: p["title"].lower())}

    def get_page(self, page_id: str) -> dict[str, Any]:
        item = self._db.get_page(page_id)
        if not item:
            raise ValidationError("La página no existe.")
        page = {**self._meta(item), "body": item.get("body", "")}
        self._attach_names([page])
        return page

    def list_revisions(self, page_id: str) -> dict[str, Any]:
        if not self._db.get_page(page_id):
            raise ValidationError("La página no existe.")
        revs = [{
            "revId": i.get("SK", ""),
            "title": i.get("title", ""),
            "savedAt": i.get("savedAt", ""),
            "savedBy": i.get("savedBy", ""),
        } for i in self._db.list_revisions(page_id)]
        revs.sort(key=lambda r: r["savedAt"], reverse=True)   # más reciente arriba
        names = NameDirectory().resolve([r["savedBy"] for r in revs if r["savedBy"]])
        for r in revs:
            r["savedByName"] = names.get(r["savedBy"], "")
        return {"pageId": page_id, "revisions": revs}

    def get_revision(self, page_id: str, rev_id: str) -> dict[str, Any]:
        # El revId es el SK (contiene '#'): viaja URL-encodeado (%23) y aquí se
        # decodifica — API Gateway no lo hace por nosotros en el proxy.
        from urllib.parse import unquote
        rev_id = unquote(rev_id or "")
        item = self._db.get_revision(page_id, rev_id)
        if not item:
            raise ValidationError("La revisión no existe.")
        return {
            "revId": rev_id, "pageId": page_id,
            "title": item.get("title", ""), "body": item.get("body", ""),
            "savedAt": item.get("savedAt", ""), "savedBy": item.get("savedBy", ""),
        }

    # ── Escritura (solo wiki_editor, guard en rutas) ──────────────────────────
    def create_page(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        title, body = self._validate(payload)
        # Título duplicado = confusión segura en una wiki: se rechaza (sin acentos).
        norm = _norm(title)
        if any(_norm(p.get("title", "")) == norm for p in self._db.list_pages()):
            raise ValidationError("Ya existe una página con ese título.")
        now = _now()
        page_id = uuid4().hex
        self._db.put_page({
            "PK": f"WIKI#{page_id}", "SK": "META", "entityType": "WIKI_PAGE",
            "pageId": page_id, "title": title, "body": body,
            "createdAt": now, "createdBy": identity["userId"],
            "updatedAt": now, "updatedBy": identity["userId"],
            "revisionCount": 0,
        })
        return self.get_page(page_id)

    def update_page(self, page_id: str, payload: dict[str, Any],
                    identity: dict[str, str]) -> dict[str, Any]:
        existing = self._db.get_page(page_id)
        if not existing:
            raise ValidationError("La página no existe.")
        title, body = self._validate(payload)
        if title != existing.get("title", ""):
            norm = _norm(title)
            if any(_norm(p.get("title", "")) == norm and p.get("pageId") != page_id
                   for p in self._db.list_pages()):
                raise ValidationError("Ya existe una página con ese título.")
        now = _now()
        # Historial: se guarda el estado ANTERIOR como revisión (append-only).
        self._db.put_revision({
            "PK": f"WIKI#{page_id}", "SK": f"REV#{existing.get('updatedAt', now)}#{uuid4().hex[:8]}",
            "entityType": "WIKI_REV", "pageId": page_id,
            "title": existing.get("title", ""), "body": existing.get("body", ""),
            "savedAt": existing.get("updatedAt", now),
            "savedBy": existing.get("updatedBy", ""),
        })
        self._db.update_page(page_id, {
            "title": title, "body": body,
            "updatedAt": now, "updatedBy": identity["userId"],
            "revisionCount": int(existing.get("revisionCount", 0)) + 1,
        })
        return self.get_page(page_id)

    def delete_page(self, page_id: str, identity: dict[str, str]) -> dict[str, Any]:
        page = self._db.get_page(page_id)
        if not page:
            raise ValidationError("La página no existe.")
        # Imágenes referenciadas (página + revisiones): se borran de S3 antes de
        # los items — mismo criterio que adjuntos (la entidad limpia su binario).
        tokens = set(_IMG_IN_BODY_RE.findall(page.get("body", "")))
        for rev in self._db.list_revisions(page_id):
            tokens |= set(_IMG_IN_BODY_RE.findall(rev.get("body", "")))
        for token in tokens:
            try:
                self._storage().delete_object(Bucket=self._bucket(), Key=self._img_key(token))
            except Exception:               # noqa: BLE001 — best-effort
                pass
        self._db.delete_page(page_id)
        return {"pageId": page_id, "removed": True}

    # ── Imágenes (pegadas con Ctrl+V en el editor) ────────────────────────────
    def _bucket(self) -> str:
        bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
        if not bucket:
            raise ValidationError("El almacenamiento de imágenes no está configurado.")
        return bucket

    def _img_key(self, token: str) -> str:
        prefix = os.environ.get("ATTACHMENTS_PREFIX", "gestion-proyectos/")
        return f"{prefix}wiki/img/{token}"

    def _storage(self):
        return boto3.client("s3", region_name=_REGION, config=Config(signature_version="s3v4"))

    def presign_image(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        content_type = str(payload.get("contentType") or "").strip().lower()
        ext = _IMG_TYPES.get(content_type)
        if not ext:
            raise ValidationError("Solo se aceptan imágenes PNG, JPEG, WebP o GIF.")
        size = int(payload.get("size") or 0)
        if size <= 0 or size > _IMG_MAX_BYTES:
            mb = _IMG_MAX_BYTES // (1024 * 1024)
            raise ValidationError(f"La imagen debe pesar entre 1 byte y {mb} MB.")
        token = f"{uuid4().hex}.{ext}"
        url = self._storage().generate_presigned_url(
            "put_object",
            Params={"Bucket": self._bucket(), "Key": self._img_key(token),
                    "ContentType": content_type},
            ExpiresIn=_PRESIGN_PUT_TTL,
        )
        return {"token": token, "uploadUrl": url, "contentType": content_type,
                "expiresIn": _PRESIGN_PUT_TTL, "maxBytes": _IMG_MAX_BYTES}

    # ── Limpieza de imágenes huérfanas ────────────────────────────────────────
    def maybe_start_cleanup(self, function_name: str) -> None:
        """Best-effort: si la última limpieza tiene más de 24 h, dispara una en
        segundo plano (self-invoke). Se llama al guardar/borrar páginas; NUNCA
        rompe la operación del usuario."""
        try:
            marker = self._db.get_cleanup_marker()
            now = datetime.now(timezone.utc)
            if marker:
                started = datetime.fromisoformat(marker.get("startedAt", "1970-01-01T00:00:00+00:00"))
                if now - started < _CLEANUP_INTERVAL:
                    return
            # El marcador se escribe ANTES de invocar (evita estampidas si dos
            # guardados coinciden; en el peor caso corre dos veces — es idempotente).
            self._db.put_cleanup_marker(now.isoformat())
            if function_name:
                import boto3 as _boto3
                _boto3.client("lambda").invoke(
                    FunctionName=function_name, InvocationType="Event",
                    Payload=json.dumps({"action": "wiki_images_cleanup"}).encode())
        except Exception:                   # noqa: BLE001
            logger.warning("No se pudo programar la limpieza de imágenes de la Wiki", exc_info=True)

    def cleanup_orphan_images(self) -> dict[str, int]:
        """Borra de S3 (wiki/img/) los objetos que NINGÚN contenido referencia —
        ni el cuerpo vigente de una página ni ninguna revisión (si una revisión
        la usa, borrarla rompería el historial) — con antigüedad mínima de 24 h
        (gracia para editores abiertos sin guardar). Idempotente y seguro de
        re-ejecutar; también invocable a mano: aws lambda invoke con
        {"action":"wiki_images_cleanup"}."""
        referenced: set[str] = set()
        for page in self._db.list_pages():
            referenced |= set(_IMG_IN_BODY_RE.findall(page.get("body", "")))
            for rev in self._db.list_revisions(page.get("pageId", "")):
                referenced |= set(_IMG_IN_BODY_RE.findall(rev.get("body", "")))

        s3 = self._storage()
        bucket = self._bucket()
        prefix = self._img_key("")          # .../wiki/img/
        cutoff = datetime.now(timezone.utc) - _ORPHAN_MIN_AGE
        stats = {"revisados": 0, "borrados": 0, "referenciados": len(referenced)}
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
        while True:
            resp = s3.list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []):
                stats["revisados"] += 1
                token = obj["Key"].removeprefix(prefix)
                if token in referenced:
                    continue
                if obj.get("LastModified") and obj["LastModified"] > cutoff:
                    continue                # recién subida: puede estar en un editor abierto
                try:
                    s3.delete_object(Bucket=bucket, Key=obj["Key"])
                    stats["borrados"] += 1
                except Exception:           # noqa: BLE001
                    logger.warning("No se pudo borrar la imagen huérfana %s", obj["Key"], exc_info=True)
            if not resp.get("IsTruncated"):
                break
            kwargs["ContinuationToken"] = resp.get("NextContinuationToken")
        logger.info("Limpieza de imágenes Wiki: %s", stats)
        return stats

    def image_url(self, token: str) -> dict[str, Any]:
        token = (token or "").strip()
        if not _IMG_TOKEN_RE.match(token):
            raise ValidationError("Imagen inválida.")
        url = self._storage().generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket(), "Key": self._img_key(token)},
            ExpiresIn=_PRESIGN_GET_TTL,
        )
        return {"token": token, "url": url, "expiresIn": _PRESIGN_GET_TTL}

    # ── Helpers ───────────────────────────────────────────────────────────────
    def _validate(self, payload: dict[str, Any]) -> tuple[str, str]:
        title = (payload.get("title") or "").strip()
        body = (payload.get("body") or "").strip()
        if not title:
            raise ValidationError("El título es obligatorio.")
        if len(title) > TITLE_MAX:
            raise ValidationError(f"El título supera el máximo de {TITLE_MAX} caracteres.")
        if not body:
            raise ValidationError("El contenido no puede estar vacío.")
        if len(body) > BODY_MAX:
            raise ValidationError(f"El contenido supera el máximo de {BODY_MAX:,} caracteres.")
        return title, body

    def _meta(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "pageId": item.get("pageId", ""),
            "title": item.get("title", ""),
            "updatedAt": item.get("updatedAt", ""),
            "updatedBy": item.get("updatedBy", ""),
            "createdAt": item.get("createdAt", ""),
            "createdBy": item.get("createdBy", ""),
            "revisionCount": int(item.get("revisionCount", 0)),
        }

    def _attach_names(self, pages: list[dict[str, Any]]) -> None:
        emails = [p["updatedBy"] for p in pages if p.get("updatedBy")]
        if not emails:
            return
        names = NameDirectory().resolve(emails)
        for p in pages:
            p["updatedByName"] = names.get(p.get("updatedBy", ""), "")


def _norm(text: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFD", (text or "").lower().strip())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")
