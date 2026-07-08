"""Personal (gestión del equipo): ausencias tipadas + saldo simple de vacaciones.

Decisiones (2026-07-07, ver bitácora):
  - NO es un módulo del menú: se abre desde el menú del usuario (arriba de
    "Salir"). Cualquier usuario autenticado Y configurado puede VER; solo
    administradores registran/editan (guard admin en las rutas de escritura).
  - Ausencias sobre las MISMAS personas del workspace (PERSON#), como items
    PERSON_ABSENCE. Tipos: vacation | leave | sick.
  - Saldo simple: días de vacaciones por año asignados a mano en el perfil de la
    persona (vacationDays = {"2026": 20}); consumido = días HÁBILES (L-V, sin
    feriados en v1) de sus ausencias tipo vacation, partido por año.
  - Coordinación operativa del equipo, NO un sistema de RRHH (sin nómina,
    expediente ni aprobaciones — el registro oficial es del banco).
"""
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import uuid4

from core.errors import UserNotConfiguredError, ValidationError
from repositories.staff import StaffRepository
from repositories.users import UsersRepository

ABSENCE_TYPES = ["vacation", "leave", "sick"]
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NOTES_MAX = 500


class StaffService:
    def __init__(self, repository: StaffRepository | None = None) -> None:
        self._repository = repository or StaffRepository()

    # ── Lectura (cualquier usuario configurado) ───────────────────────────────
    def get_staff(self, identity: dict[str, str]) -> dict[str, Any]:
        # La vista no exige un módulo asignado, pero sí un perfil funcional (no
        # basta un JWT válido de Cognito).
        if UsersRepository().get_user_profile(identity["userId"]) is None:
            raise UserNotConfiguredError("El usuario autenticado no está configurado funcionalmente.")

        absences_by: dict[str, list] = {}
        for item in self._repository.list_all_absences():
            absences_by.setdefault(item.get("personId", ""), []).append(self._normalize_absence(item))

        people = []
        current_year = str(datetime.now(UTC).year)
        for item in self._repository.list_people():
            person_id = item["personId"]
            absences = sorted(absences_by.get(person_id, []),
                              key=lambda a: a["startDate"], reverse=True)
            allocated = self._allocated_days(item)
            used = self._used_vacation_days(absences)
            people.append({
                "id": person_id,
                "fullName": item.get("fullName", ""),
                "area": item.get("area", ""),
                "status": item.get("status", ""),
                # Nota EXCLUSIVA de Personal (staffNotes) — separada de las notas
                # generales de la persona en Solicitudes (notes).
                "staffNotes": item.get("staffNotes", ""),
                "absences": absences,
                # Saldo del año en curso (asignado/consumido/restante); None si
                # el admin no ha asignado días a esta persona.
                "vacationDays": {
                    "year": current_year,
                    "allocated": allocated.get(current_year),
                    "used": used.get(current_year, 0),
                },
            })
        people.sort(key=lambda p: p["fullName"].lower())
        return {"people": people, "absenceTypes": ABSENCE_TYPES}

    # ── Escritura (solo admin — guard en la ruta) ─────────────────────────────
    def create_absence(self, person_id: str, payload: dict[str, Any],
                       identity: dict[str, str]) -> dict[str, Any]:
        person_id = self._require(person_id, "Persona")
        if not self._repository.get_person(person_id):
            raise ValidationError("La persona no existe.")
        absence_type = self._valid_type(payload.get("type"))
        start, end = self._valid_range(payload.get("startDate"), payload.get("endDate"))
        notes = self._valid_notes(payload.get("notes"))
        self._ensure_no_overlap(person_id, start, end)
        now = self._now()
        absence_id = uuid4().hex
        item = {
            "PK": f"PERSON#{person_id}",
            "SK": f"ABSENCE#{absence_id}",
            "entityType": "PERSON_ABSENCE",
            "personId": person_id,
            "absenceId": absence_id,
            "type": absence_type,
            "startDate": start,
            "endDate": end,
            "notes": notes,
            "createdAt": now,
            "updatedAt": now,
            "createdBy": identity["userId"],
            "updatedBy": identity["userId"],
        }
        self._repository.put_item(item)
        return self._normalize_absence(item)

    def update_absence(self, person_id: str, absence_id: str, payload: dict[str, Any],
                       identity: dict[str, str]) -> dict[str, Any]:
        existing = self._repository.get_absence(person_id, absence_id)
        if not existing:
            raise ValidationError("La ausencia no existe.")
        values: dict[str, Any] = {"updatedAt": self._now(), "updatedBy": identity["userId"]}
        if "type" in payload:
            values["type"] = self._valid_type(payload.get("type"))
        if "startDate" in payload or "endDate" in payload:
            start, end = self._valid_range(
                payload.get("startDate") or existing.get("startDate"),
                payload.get("endDate") or existing.get("endDate"))
            self._ensure_no_overlap(person_id, start, end, exclude_id=absence_id)
            values["startDate"], values["endDate"] = start, end
        if "notes" in payload:
            values["notes"] = self._valid_notes(payload.get("notes"))
        return self._normalize_absence(self._repository.update_absence(person_id, absence_id, values))

    def delete_absence(self, person_id: str, absence_id: str,
                       identity: dict[str, str]) -> dict[str, Any]:
        self._repository.delete_absence(person_id, absence_id)
        return {"personId": person_id, "absenceId": absence_id, "removed": True}

    def set_vacation_days(self, person_id: str, payload: dict[str, Any],
                          identity: dict[str, str]) -> dict[str, Any]:
        """Asigna los días de vacaciones de un AÑO (número manual del admin)."""
        person = self._repository.get_person(self._require(person_id, "Persona"))
        if not person:
            raise ValidationError("La persona no existe.")
        year = str(payload.get("year") or "").strip()
        if not re.match(r"^\d{4}$", year):
            raise ValidationError("El año debe tener formato AAAA.")
        try:
            days = int(payload.get("days"))
        except (TypeError, ValueError):
            raise ValidationError("Los días asignados deben ser un número entero.")
        if days < 0 or days > 60:
            raise ValidationError("Los días asignados deben estar entre 0 y 60.")
        allocated = dict(person.get("vacationDays") or {})
        allocated[year] = days
        self._repository.update_person(person_id, {
            "vacationDays": allocated,
            "updatedAt": self._now(),
            "updatedBy": identity["userId"],
        })
        return {"personId": person_id, "year": year, "days": days}

    def set_notes(self, person_id: str, payload: dict[str, Any],
                  identity: dict[str, str]) -> dict[str, Any]:
        """Nota de la persona SOLO para la sección Personal (campo staffNotes)."""
        person = self._repository.get_person(self._require(person_id, "Persona"))
        if not person:
            raise ValidationError("La persona no existe.")
        notes = str(payload.get("notes") or "").strip()
        if len(notes) > 1000:
            raise ValidationError("La nota supera el máximo de 1000 caracteres.")
        self._repository.update_person(person_id, {
            "staffNotes": notes,
            "updatedAt": self._now(),
            "updatedBy": identity["userId"],
        })
        return {"personId": person_id, "staffNotes": notes}

    # ── Saldo: días hábiles (L-V) de vacaciones, partidos por año ─────────────
    @staticmethod
    def _allocated_days(person_item: dict[str, Any]) -> dict[str, int]:
        raw = person_item.get("vacationDays") or {}
        return {str(y): int(d) for y, d in raw.items()}

    def _used_vacation_days(self, absences: list[dict[str, Any]]) -> dict[str, int]:
        used: dict[str, int] = {}
        for absence in absences:
            if absence["type"] != "vacation":
                continue
            for day in self._iter_days(absence["startDate"], absence["endDate"]):
                if day.weekday() < 5:  # L-V (sin feriados en v1)
                    year = str(day.year)
                    used[year] = used.get(year, 0) + 1
        return used

    @staticmethod
    def _iter_days(start: str, end: str):
        current = date.fromisoformat(start)
        last = date.fromisoformat(end)
        while current <= last:
            yield current
            current += timedelta(days=1)

    # ── Validaciones ──────────────────────────────────────────────────────────
    def _valid_type(self, value: Any) -> str:
        absence_type = str(value or "").strip()
        if absence_type not in ABSENCE_TYPES:
            raise ValidationError("El tipo de ausencia no es válido.")
        return absence_type

    def _valid_range(self, start: Any, end: Any) -> tuple[str, str]:
        start = str(start or "").strip()
        end = str(end or "").strip() or start
        for label, value in (("inicio", start), ("fin", end)):
            if not _DATE_RE.match(value):
                raise ValidationError(f"La fecha de {label} debe tener formato AAAA-MM-DD.")
            try:
                date.fromisoformat(value)
            except ValueError:
                raise ValidationError(f"La fecha de {label} no es válida.")
        if end < start:
            raise ValidationError("La fecha fin debe ser igual o posterior a la de inicio.")
        return start, end

    def _valid_notes(self, value: Any) -> str:
        notes = str(value or "").strip()
        if len(notes) > _NOTES_MAX:
            raise ValidationError(f"La nota supera el máximo de {_NOTES_MAX} caracteres.")
        return notes

    def _ensure_no_overlap(self, person_id: str, start: str, end: str, exclude_id: str = "") -> None:
        """Prevención de error: dos ausencias de la MISMA persona no se traslapan."""
        for item in self._repository.list_person_absences(person_id):
            if item.get("absenceId") == exclude_id:
                continue
            if start <= item.get("endDate", "") and end >= item.get("startDate", ""):
                raise ValidationError(
                    f"Se traslapa con otra ausencia registrada "
                    f"({item.get('startDate')} → {item.get('endDate')}). Edita esa o ajusta las fechas.")

    def _normalize_absence(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item["absenceId"],
            "personId": item["personId"],
            "type": item.get("type", ""),
            "startDate": item.get("startDate", ""),
            "endDate": item.get("endDate", ""),
            "notes": item.get("notes", ""),
            "updatedAt": item.get("updatedAt", ""),
        }

    @staticmethod
    def _require(value: Any, label: str) -> str:
        text = str(value or "").strip()
        if not text:
            raise ValidationError(f"{label} es obligatorio.")
        return text

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()
