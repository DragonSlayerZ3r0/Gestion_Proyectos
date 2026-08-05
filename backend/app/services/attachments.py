"""Adjuntos de solicitudes: archivos (pantallazos, pdf, csv…) y queries de texto.

Estrategia (ver docs/08 y docs/04):
  - Los BINARIOS viven en un bucket S3 privado y compartido (prefijo por app); la
    metadata vive como item ATTACHMENT en DynamoDB. El binario NUNCA pasa por la
    Lambda ni por DynamoDB: el navegador sube directo a S3 con una URL prefirmada
    (presigned PUT) y se ve con una presigned GET de corta vida.
  - Las QUERIES (texto/SQL) NO usan S3: son texto pequeño que se lee y copia en la
    UI → se guardan inline en el item ATTACHMENT (kind="query").

Portabilidad (plan multinube): todo el acceso al almacenamiento pasa por _storage()
y los métodos presign/get/delete de este servicio — el puerto "BlobStore". Cambiar
de S3 a GCS/Azure es reemplazar este adaptador, no el resto del backend.
"""
import os
import re
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import boto3
from botocore.config import Config

from core.errors import ValidationError
from repositories.workspace import WorkspaceRepository
from services.name_directory import NameDirectory

# Política de tipos (2026-07-08, pedido del usuario): BLOCKLIST en vez de
# whitelist — se acepta prácticamente cualquier binario de trabajo (Excel, Word,
# parquet, zip…; la whitelist inicial rechazaba .xlsx). Se bloquean SOLO
# ejecutables/scripts y páginas activas (html/svg ejecutan scripts al abrirse
# desde la presigned GET). El tope de 15 MB se mantiene.
_BLOCKED_EXTENSIONS = {
    "exe", "dll", "msi", "bat", "cmd", "com", "scr", "pif", "cpl",  # ejecutables Windows
    "ps1", "psm1", "sh", "bash", "zsh", "vbs", "vbe", "wsf", "hta", # scripts
    "js", "mjs", "jar", "apk", "app", "lnk",                        # otros ejecutables
    "html", "htm", "svg", "xhtml",                                  # páginas activas
}
_MAX_FILE_BYTES = 15 * 1024 * 1024   # 15 MB por archivo
_QUERY_MAX_CHARS = 20000             # texto de una query adjunta
_PRESIGN_PUT_TTL = 120               # s para subir
_PRESIGN_GET_TTL = 300               # s para ver/descargar
_REGION = "us-east-1"
_KIND_FILE = "file"
_KIND_QUERY = "query"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


class AttachmentService:
    def __init__(self, repository: WorkspaceRepository | None = None) -> None:
        self._repository = repository or WorkspaceRepository()

    # ── Almacenamiento (puerto BlobStore, adaptador S3) ───────────────────────
    def _bucket(self) -> str:
        bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
        if not bucket:
            raise ValidationError("El almacenamiento de adjuntos no está configurado.")
        return bucket

    def _prefix(self) -> str:
        return os.environ.get("ATTACHMENTS_PREFIX", "gestion-proyectos/")

    def _storage(self):
        # SigV4 explícito: las URLs prefirmadas deben firmarse con s3v4.
        return boto3.client("s3", region_name=_REGION, config=Config(signature_version="s3v4"))

    def _object_key(self, project_id: str, attachment_id: str, file_name: str) -> str:
        """Llave determinista (presign y confirm calculan la MISMA): así el confirm
        no confía en una llave enviada por el cliente."""
        return f"{self._prefix()}projects/{project_id}/{attachment_id}-{self._safe_name(file_name)}"

    @staticmethod
    def _safe_name(name: str) -> str:
        name = _SAFE_NAME_RE.sub("_", (name or "").strip()) or "archivo"
        return name[-120:]  # acota longitud, conserva la extensión (al final)

    # ── Ruta relativa (carpetas, 2026-07-31) ──────────────────────────────────
    # La estructura de carpetas se guarda como TEXTO en el adjunto; el árbol se
    # deriva de esas rutas al dibujar. No hay entidad "carpeta": una carpeta sin
    # archivos no existe, renombrar es cambiar un prefijo y borrarla es borrar
    # sus archivos — inventar la entidad traería sincronización y huérfanos para
    # no ganar nada (es también el motivo por el que S3 no tiene carpetas).
    # OJO: la ruta NO entra en la llave de S3 (esa sigue siendo por id): así no
    # hay que lidiar con acentos, espacios ni colisiones en el almacenamiento.
    _PATH_MAX_CHARS = 400
    _PATH_MAX_DEPTH = 10

    @classmethod
    def _validate_path(cls, value: Any) -> str:
        raw = str(value or "").strip().strip("/")
        if not raw:
            return ""
        # ".." fuera: aunque la ruta no toque S3, se muestra y se usa para armar
        # el zip — no puede escaparse de su carpeta al descomprimir.
        partes = [p.strip() for p in raw.replace("\\", "/").split("/")]
        partes = [p for p in partes if p and p != "."]
        if any(p == ".." for p in partes):
            raise ValidationError("La ruta del archivo no es válida.")
        if len(partes) > cls._PATH_MAX_DEPTH:
            raise ValidationError(
                f"La carpeta tiene más de {cls._PATH_MAX_DEPTH} niveles de profundidad.")
        ruta = "/".join(partes)
        if len(ruta) > cls._PATH_MAX_CHARS:
            raise ValidationError(
                f"La ruta supera los {cls._PATH_MAX_CHARS} caracteres.")
        return ruta

    # ── Subida de archivo: presign → (PUT directo del navegador) → confirm ────
    def presign_upload(self, project_id: str, payload: dict[str, Any],
                       identity: dict[str, str]) -> dict[str, Any]:
        project_id = self._require(project_id, "Proyecto")
        if not self._repository.get_project(project_id):
            raise ValidationError("La solicitud no existe.")
        file_name = self._require(payload.get("fileName"), "Nombre del archivo")
        self._validate_extension(file_name)
        content_type = str(payload.get("contentType") or "application/octet-stream").strip()
        size = self._validate_size(payload.get("size"))
        attachment_id = uuid4().hex
        key = self._object_key(project_id, attachment_id, file_name)
        url = self._storage().generate_presigned_url(
            "put_object",
            Params={"Bucket": self._bucket(), "Key": key, "ContentType": content_type},
            ExpiresIn=_PRESIGN_PUT_TTL,
        )
        # El item se crea en confirm_upload (cuando el PUT ya subió el binario).
        return {
            "attachmentId": attachment_id,
            "uploadUrl": url,
            "contentType": content_type,
            "expiresIn": _PRESIGN_PUT_TTL,
            "maxBytes": _MAX_FILE_BYTES,
        }

    def confirm_upload(self, project_id: str, payload: dict[str, Any],
                       identity: dict[str, str]) -> dict[str, Any]:
        project_id = self._require(project_id, "Proyecto")
        if not self._repository.get_project(project_id):
            raise ValidationError("La solicitud no existe.")
        attachment_id = self._require(payload.get("attachmentId"), "Adjunto")
        file_name = self._require(payload.get("fileName"), "Nombre del archivo")
        self._validate_extension(file_name)
        content_type = str(payload.get("contentType") or "application/octet-stream").strip()
        size = self._validate_size(payload.get("size"))
        update_id = str(payload.get("updateId") or "").strip()  # contexto opcional
        # La llave se RECALCULA aquí (no se confía en la del cliente).
        key = self._object_key(project_id, attachment_id, file_name)
        now = self._now()
        item = {
            "PK": f"PROJECT#{project_id}",
            "SK": f"ATTACH#{attachment_id}",
            "entityType": "ATTACHMENT",
            "projectId": project_id,
            "attachmentId": attachment_id,
            "kind": _KIND_FILE,
            "storageKey": key,
            "fileName": file_name,
            "contentType": content_type,
            "size": size,
            "updateId": update_id,
            "path": self._validate_path(payload.get("path")),
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"],
        }
        self._repository.put_item(item)
        return self._normalize(item, resolve_author=True)

    # ── Query adjunta (texto inline, sin S3) ──────────────────────────────────
    def create_query(self, project_id: str, payload: dict[str, Any],
                     identity: dict[str, str]) -> dict[str, Any]:
        project_id = self._require(project_id, "Proyecto")
        if not self._repository.get_project(project_id):
            raise ValidationError("La solicitud no existe.")
        text = self._require(payload.get("text"), "Texto de la query")
        if len(text) > _QUERY_MAX_CHARS:
            raise ValidationError(f"La query supera el máximo de {_QUERY_MAX_CHARS} caracteres.")
        title = str(payload.get("title") or "").strip()
        update_id = str(payload.get("updateId") or "").strip()
        now = self._now()
        attachment_id = uuid4().hex
        item = {
            "PK": f"PROJECT#{project_id}",
            "SK": f"ATTACH#{attachment_id}",
            "entityType": "ATTACHMENT",
            "projectId": project_id,
            "attachmentId": attachment_id,
            "kind": _KIND_QUERY,
            "title": title,
            "text": text,
            "updateId": update_id,
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"],
        }
        self._repository.put_item(item)
        return self._normalize(item, resolve_author=True)

    # ── Lista de UNA solicitud (carga diferida, 2026-07-31) ───────────────────
    # Antes los adjuntos de TODAS las solicitudes viajaban en /api/workspace.
    # Con carpetas eso no escala: medido, 1.156 bytes de metadata por adjunto —
    # veinte solicitudes con una carpeta de 50 archivos sumarían más de 1 MB a
    # CADA carga y a cada refresco automático. Ahora la lista se pide al abrir
    # la solicitud y el workspace solo lleva el conteo.
    def list_for_project(self, project_id: str) -> list[dict[str, Any]]:
        project_id = self._require(project_id, "Proyecto")
        items = self._repository.list_project_attachments(project_id)
        data = [self._normalize(i) for i in items]
        # Autores en UN solo lote (no uno por adjunto): misma caché que usa
        # get_workspace para los seguimientos.
        correos = [a["createdBy"] for a in data if a["createdBy"]]
        if correos:
            nombres = NameDirectory().resolve(correos)
            for a in data:
                a["createdByName"] = nombres.get(a["createdBy"], "")
        data.sort(key=lambda a: a["createdAt"], reverse=True)
        return data

    # ── Relacionar con una entrada de seguimiento (o General) ─────────────────
    def relate_folder(self, project_id: str, payload: dict[str, Any],
                      identity: dict[str, str]) -> dict[str, Any]:
        """Relaciona de una vez TODOS los archivos de una carpeta con una entrada
        de seguimiento (2026-07-31). Con 89 archivos subidos de golpe, pedir la
        relación uno por uno no es una opción: el seguimiento es de la ENTREGA
        completa, no de cada archivo. Como las carpetas se derivan de las rutas,
        esto es una escritura por archivo — pero en UNA sola llamada, no 89."""
        project_id = self._require(project_id, "Proyecto")
        ruta = self._validate_path(payload.get("path"))
        update_id = str(payload.get("updateId") or "").strip()
        if update_id and not self._repository.get_project_update(project_id, update_id):
            raise ValidationError("La entrada de seguimiento no existe.")
        now = self._now()
        tocados = 0
        for item in self._repository.list_project_attachments(project_id):
            p = item.get("path", "")
            # La carpeta y TODO lo que cuelga de ella (subcarpetas incluidas).
            if not (p == ruta or (ruta and p.startswith(f"{ruta}/"))):
                continue
            self._repository.update_attachment(
                project_id, item["attachmentId"],
                {"updateId": update_id, "updatedAt": now, "updatedBy": identity["userId"]})
            tocados += 1
        return {"path": ruta, "updateId": update_id, "updated": tocados}

    def relate(self, project_id: str, attachment_id: str, payload: dict[str, Any],
               identity: dict[str, str]) -> dict[str, Any]:
        """Cambia el contexto del adjunto: lo liga a una entrada de seguimiento
        (updateId) o lo deja General (updateId=""). El '+ Nueva nota' del frontend
        crea antes la entrada (POST /updates) y luego llama aquí con su id."""
        item = self._repository.get_attachment(project_id, attachment_id)
        if not item:
            raise ValidationError("El adjunto no existe.")
        update_id = str(payload.get("updateId") or "").strip()
        if update_id and not self._repository.get_project_update(project_id, update_id):
            raise ValidationError("La entrada de seguimiento no existe.")
        values = {"updateId": update_id, "updatedAt": self._now(), "updatedBy": identity["userId"]}
        updated = self._repository.update_attachment(project_id, attachment_id, values)
        return self._normalize(updated, resolve_author=True)

    # ── Ver/descargar: presigned GET de corta vida (solo archivos) ────────────
    def get_download_url(self, project_id: str, attachment_id: str,
                         identity: dict[str, str]) -> dict[str, Any]:
        item = self._repository.get_attachment(project_id, attachment_id)
        if not item:
            raise ValidationError("El adjunto no existe.")
        if item.get("kind") != _KIND_FILE:
            raise ValidationError("Este adjunto no es un archivo.")
        url = self._storage().generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket(), "Key": item["storageKey"]},
            ExpiresIn=_PRESIGN_GET_TTL,
        )
        return {"url": url, "expiresIn": _PRESIGN_GET_TTL}

    def delete(self, project_id: str, attachment_id: str,
               identity: dict[str, str]) -> dict[str, Any]:
        item = self._repository.get_attachment(project_id, attachment_id)
        if not item:
            return {"projectId": project_id, "attachmentId": attachment_id, "removed": True}
        if item.get("kind") == _KIND_FILE and item.get("storageKey"):
            self._delete_object(item["storageKey"])
        self._repository.delete_attachment(project_id, attachment_id)
        return {"projectId": project_id, "attachmentId": attachment_id, "removed": True}

    def _delete_object(self, key: str) -> None:
        try:
            self._storage().delete_object(Bucket=self._bucket(), Key=key)
        except Exception:  # noqa: BLE001 — borrar el binario no debe romper el borrado del item
            pass

    # ── Normalización + helpers ───────────────────────────────────────────────
    def normalize(self, item: dict[str, Any]) -> dict[str, Any]:
        """Público para get_workspace (el autor se resuelve en lote allá)."""
        return self._normalize(item, resolve_author=False)

    def _normalize(self, item: dict[str, Any], resolve_author: bool = False) -> dict[str, Any]:
        kind = item.get("kind", _KIND_FILE)
        data = {
            "id": item["attachmentId"],
            "projectId": item["projectId"],
            "kind": kind,
            "updateId": item.get("updateId", ""),
            "path": item.get("path", ""),
            "createdBy": item.get("createdBy", ""),
            "createdByName": "",
            "createdAt": item.get("createdAt", ""),
        }
        if kind == _KIND_QUERY:
            data["title"] = item.get("title", "")
            data["text"] = item.get("text", "")
        else:
            data["fileName"] = item.get("fileName", "")
            data["contentType"] = item.get("contentType", "")
            data["size"] = int(item.get("size", 0) or 0)
        if resolve_author and data["createdBy"]:
            data["createdByName"] = NameDirectory().resolve([data["createdBy"]]).get(data["createdBy"], "")
        return data

    def _validate_extension(self, file_name: str) -> None:
        ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
        if ext in _BLOCKED_EXTENSIONS:
            raise ValidationError(
                f"Por seguridad no se permiten archivos .{ext} "
                "(ejecutables, scripts o páginas). Cualquier otro tipo sí.")

    def _validate_size(self, value: Any) -> int:
        try:
            size = int(value)
        except (TypeError, ValueError):
            raise ValidationError("Tamaño de archivo inválido.")
        if size <= 0:
            raise ValidationError("El archivo está vacío.")
        if size > _MAX_FILE_BYTES:
            mb = _MAX_FILE_BYTES // (1024 * 1024)
            raise ValidationError(f"El archivo supera el máximo de {mb} MB.")
        return size

    @staticmethod
    def _require(value: Any, label: str) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValidationError(f"{label} es obligatorio.")
        return text

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()
