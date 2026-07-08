"""Pizarras (módulo draw): lienzo Excalidraw con compartir selectivo.

Modelo (decidido 2026-07-07):
  - Cada pizarra tiene DUEÑO (quien la crea). Sin compartir, solo él la ve.
  - El dueño invita usuarios concretos ("compartir con"); el invitado ve la
    invitación y la ACEPTA o RECHAZA. Aceptada → ve y edita la pizarra.
  - Solo el dueño comparte/revoca/renombra/elimina.

Almacenamiento: la escena (JSON formato .excalidraw, puede pesar MB si pegan
imágenes) vive en S3 — mismo bucket compartido de adjuntos, prefijo
`drawings/` — vía URLs prefirmadas (el JSON nunca pasa por la Lambda). La
metadata (DRAWING) y las invitaciones (DRAWING_SHARE) viven en DynamoDB.
"""
import os
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import boto3
from botocore.config import Config

from core.errors import ValidationError
from repositories.drawings import DrawingsRepository
from repositories.users import UsersRepository
from services.name_directory import NameDirectory

_PRESIGN_PUT_TTL = 120
_PRESIGN_GET_TTL = 300
_REGION = "us-east-1"
_NAME_MAX = 120
_SCENE_CONTENT_TYPE = "application/json"


class DrawingService:
    def __init__(self, repository: DrawingsRepository | None = None) -> None:
        self._repository = repository or DrawingsRepository()

    # ── Almacenamiento (mismo puerto BlobStore que adjuntos) ──────────────────
    def _bucket(self) -> str:
        bucket = os.environ.get("ATTACHMENTS_BUCKET", "")
        if not bucket:
            raise ValidationError("El almacenamiento de pizarras no está configurado.")
        return bucket

    def _scene_key(self, drawing_id: str) -> str:
        prefix = os.environ.get("ATTACHMENTS_PREFIX", "gestion-proyectos/")
        return f"{prefix}drawings/{drawing_id}.excalidraw"

    def _storage(self):
        return boto3.client("s3", region_name=_REGION, config=Config(signature_version="s3v4"))

    # ── Listado para el usuario (mías + compartidas conmigo + invitaciones) ───
    def list_for_user(self, identity: dict[str, str]) -> dict[str, Any]:
        me = identity["userId"]
        drawings = {d["drawingId"]: d for d in self._repository.list_drawings()}
        all_shares = self._repository.list_all_shares()

        # Shares agrupados por pizarra (para el conteo del dueño) y los míos.
        shares_by_drawing: dict[str, list] = {}
        my_shares: list[dict[str, Any]] = []
        for share in all_shares:
            shares_by_drawing.setdefault(share.get("drawingId", ""), []).append(share)
            if share.get("userId") == me:
                my_shares.append(share)

        mine = [self._normalize(d, shares_by_drawing.get(d["drawingId"], []))
                for d in drawings.values() if d.get("ownerUserId") == me]
        shared, invitations = [], []
        for share in my_shares:
            drawing = drawings.get(share.get("drawingId", ""))
            if not drawing:
                continue
            normalized = self._normalize(drawing, shares_by_drawing.get(drawing["drawingId"], []))
            if share.get("status") == "accepted":
                shared.append(normalized)
            else:
                invitations.append(normalized)

        # Nombre legible de dueños e invitados en un solo viaje (caché compartida).
        emails = {d["ownerUserId"] for d in drawings.values() if d.get("ownerUserId")}
        emails |= {s.get("userId", "") for s in all_shares}
        names = NameDirectory().resolve([e for e in emails if e]) if emails else {}
        for group in (mine, shared, invitations):
            for d in group:
                d["ownerName"] = names.get(d["ownerUserId"], "") or d["ownerUserId"]
                for s in d["shares"]:
                    s["userName"] = names.get(s["userId"], "") or s["userId"]

        by_recent = lambda d: d["updatedAt"]
        return {
            "mine": sorted(mine, key=by_recent, reverse=True),
            "shared": sorted(shared, key=by_recent, reverse=True),
            "invitations": sorted(invitations, key=by_recent, reverse=True),
        }

    # ── Usuarios para el selector "Compartir con" ─────────────────────────────
    def list_people(self, identity: dict[str, str]) -> list[dict[str, Any]]:
        """Usuarios de la app (correo + nombre), sin el propio. Solo datos de
        directorio — nada de roles ni permisos."""
        me = identity["userId"]
        people = []
        for item in UsersRepository().list_all_user_items():
            if item.get("SK") != "PROFILE":
                continue
            email = str(item.get("PK", "")).split("USER#", 1)[-1]
            if not email or email == me:
                continue
            people.append({"email": email, "name": item.get("name") or email})
        return sorted(people, key=lambda p: p["name"].lower())

    # ── CRUD ──────────────────────────────────────────────────────────────────
    def create(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        name = self._valid_name(payload.get("name"))
        now = self._now()
        drawing_id = uuid4().hex
        item = {
            "PK": f"DRAWING#{drawing_id}",
            "SK": "META",
            "entityType": "DRAWING",
            "drawingId": drawing_id,
            "name": name,
            "ownerUserId": identity["userId"],
            "storageKey": self._scene_key(drawing_id),
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"],
        }
        self._repository.put_item(item)
        drawing = self._normalize(item, [])
        drawing["ownerName"] = ""
        return drawing

    def rename(self, drawing_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        drawing = self._require_drawing(drawing_id)
        self._ensure_owner(drawing, identity)
        values = {"name": self._valid_name(payload.get("name")),
                  "updatedAt": self._now(), "updatedBy": identity["userId"]}
        updated = self._repository.update_drawing(drawing_id, values)
        return self._normalize(updated, self._repository.list_drawing_shares(drawing_id))

    def delete(self, drawing_id: str, identity: dict[str, str]) -> dict[str, Any]:
        drawing = self._require_drawing(drawing_id)
        self._ensure_owner(drawing, identity)
        try:
            self._storage().delete_object(Bucket=self._bucket(), Key=drawing["storageKey"])
        except Exception:  # noqa: BLE001 — sin escena guardada aún, o ya borrada
            pass
        self._repository.delete_drawing(drawing_id)
        return {"drawingId": drawing_id, "removed": True}

    # ── Escena: cargar (GET) y guardar (PUT) con URLs prefirmadas ─────────────
    def load_url(self, drawing_id: str, identity: dict[str, str]) -> dict[str, Any]:
        drawing = self._require_drawing(drawing_id)
        self._ensure_access(drawing, identity)
        url = self._storage().generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket(), "Key": drawing["storageKey"]},
            ExpiresIn=_PRESIGN_GET_TTL)
        return {"url": url, "expiresIn": _PRESIGN_GET_TTL}

    def save_url(self, drawing_id: str, identity: dict[str, str]) -> dict[str, Any]:
        """URL para subir la escena. Actualiza updatedAt/updatedBy aquí (el PUT va
        directo a S3; si fallara, el timestamp queda unos segundos adelantado —
        compromiso aceptado para no exigir un tercer viaje de confirmación)."""
        drawing = self._require_drawing(drawing_id)
        self._ensure_access(drawing, identity)
        url = self._storage().generate_presigned_url(
            "put_object",
            Params={"Bucket": self._bucket(), "Key": drawing["storageKey"],
                    "ContentType": _SCENE_CONTENT_TYPE},
            ExpiresIn=_PRESIGN_PUT_TTL)
        self._repository.update_drawing(drawing_id, {
            "updatedAt": self._now(), "updatedBy": identity["userId"]})
        return {"url": url, "contentType": _SCENE_CONTENT_TYPE, "expiresIn": _PRESIGN_PUT_TTL}

    # ── Compartir: invitar / revocar / responder ──────────────────────────────
    def share(self, drawing_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        drawing = self._require_drawing(drawing_id)
        self._ensure_owner(drawing, identity)
        email = str(payload.get("email") or "").strip().lower()
        if not email:
            raise ValidationError("Selecciona el usuario con quien compartir.")
        if email == drawing.get("ownerUserId"):
            raise ValidationError("Eres el dueño de esta pizarra; no hace falta compartirla contigo.")
        if not any(p["email"] == email for p in self.list_people(identity)):
            raise ValidationError("Ese usuario no existe en la aplicación.")
        if self._repository.get_share(drawing_id, email):
            raise ValidationError("Esta pizarra ya está compartida (o pendiente de aceptar) con ese usuario.")
        now = self._now()
        item = {
            "PK": f"DRAWING#{drawing_id}",
            "SK": f"SHARE#{email}",
            "entityType": "DRAWING_SHARE",
            "drawingId": drawing_id,
            "userId": email,
            "status": "pending",
            "invitedBy": identity["userId"],
            "createdAt": now,
            "updatedAt": now,
        }
        self._repository.put_item(item)
        return self._normalize_share(item)

    def revoke_share(self, drawing_id: str, email: str, identity: dict[str, str]) -> dict[str, Any]:
        drawing = self._require_drawing(drawing_id)
        self._ensure_owner(drawing, identity)
        self._repository.delete_share(drawing_id, str(email or "").strip().lower())
        return {"drawingId": drawing_id, "userId": email, "removed": True}

    def respond(self, drawing_id: str, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        """El invitado acepta (status→accepted) o rechaza (se borra el share)."""
        me = identity["userId"]
        share = self._repository.get_share(drawing_id, me)
        if not share:
            raise ValidationError("No tienes una invitación para esta pizarra.")
        if bool(payload.get("accept")):
            updated = self._repository.update_share(drawing_id, me, {
                "status": "accepted", "updatedAt": self._now()})
            return self._normalize_share(updated)
        self._repository.delete_share(drawing_id, me)
        return {"drawingId": drawing_id, "userId": me, "declined": True}

    # ── Reglas de acceso ──────────────────────────────────────────────────────
    def _require_drawing(self, drawing_id: str) -> dict[str, Any]:
        drawing_id = str(drawing_id or "").strip()
        drawing = self._repository.get_drawing(drawing_id) if drawing_id else None
        if not drawing:
            raise ValidationError("La pizarra no existe.")
        return drawing

    def _ensure_owner(self, drawing: dict[str, Any], identity: dict[str, str]) -> None:
        if drawing.get("ownerUserId") != identity["userId"]:
            raise PermissionError("Solo el dueño de la pizarra puede hacer esto.")

    def _ensure_access(self, drawing: dict[str, Any], identity: dict[str, str]) -> None:
        """Ver/editar: el dueño o un invitado que ya ACEPTÓ."""
        me = identity["userId"]
        if drawing.get("ownerUserId") == me:
            return
        share = self._repository.get_share(drawing["drawingId"], me)
        if not share or share.get("status") != "accepted":
            raise PermissionError("No tienes acceso a esta pizarra.")

    # ── Normalización + helpers ───────────────────────────────────────────────
    def _normalize(self, item: dict[str, Any], shares: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "id": item["drawingId"],
            "name": item.get("name", ""),
            "ownerUserId": item.get("ownerUserId", ""),
            "ownerName": "",
            "createdAt": item.get("createdAt", ""),
            "updatedAt": item.get("updatedAt", ""),
            "updatedBy": item.get("updatedBy", ""),
            "shares": [self._normalize_share(s) for s in shares],
        }

    def _normalize_share(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "drawingId": item.get("drawingId", ""),
            "userId": item.get("userId", ""),
            "userName": "",
            "status": item.get("status", "pending"),
            "updatedAt": item.get("updatedAt", ""),
        }

    def _valid_name(self, value: Any) -> str:
        name = str(value or "").strip()
        if not name:
            raise ValidationError("El nombre de la pizarra es obligatorio.")
        if len(name) > _NAME_MAX:
            raise ValidationError(f"El nombre supera el máximo de {_NAME_MAX} caracteres.")
        return name

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()
