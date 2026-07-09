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

        # Asuetos: catálogo HOLIDAY (los completos NO descuentan del saldo).
        holidays = sorted((self._normalize_holiday(h) for h in self._repository.list_holidays()),
                          key=lambda h: h["date"])
        full_holidays = {h["date"] for h in holidays if not h["half"]}

        people = []
        current_year = str(datetime.now(UTC).year)
        for item in self._repository.list_people():
            person_id = item["personId"]
            absences = sorted(absences_by.get(person_id, []),
                              key=lambda a: a["startDate"], reverse=True)
            allocated = self._allocated_days(item)
            used = self._used_vacation_days(absences, full_holidays)
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
        return {"people": people, "absenceTypes": ABSENCE_TYPES, "holidays": holidays}

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

    # ── Asuetos (catálogo HOLIDAY; escritura solo admin) ──────────────────────
    def save_holidays(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        """Upsert masivo (la pantalla de confirmación del extractor y el alta
        manual usan el mismo endpoint). Cada asueto: date + name + half."""
        holidays = payload.get("holidays")
        if not isinstance(holidays, list) or not holidays:
            raise ValidationError("No hay asuetos que guardar.")
        if len(holidays) > 60:
            raise ValidationError("Demasiados asuetos en una sola carga.")
        now = self._now()
        saved = []
        for holiday in holidays:
            date_str = str(holiday.get("date") or "").strip()
            if not _DATE_RE.match(date_str):
                raise ValidationError(f"Fecha de asueto inválida: {date_str or '(vacía)'} (formato AAAA-MM-DD).")
            name = str(holiday.get("name") or "").strip()
            if not name:
                raise ValidationError(f"El asueto del {date_str} no tiene nombre.")
            item = {
                "PK": f"HOLIDAY#{date_str}",
                "SK": "PROFILE",
                "entityType": "HOLIDAY",
                "date": date_str,
                "name": name[:120],
                "half": bool(holiday.get("half")),
                "notes": str(holiday.get("notes") or "").strip()[:200],
                "createdAt": now,
                "updatedAt": now,
                "createdBy": identity["userId"],
                "updatedBy": identity["userId"],
            }
            self._repository.put_item(item)
            saved.append(self._normalize_holiday(item))
        return {"holidays": sorted(saved, key=lambda h: h["date"])}

    def delete_holiday(self, date_str: str, identity: dict[str, str]) -> dict[str, Any]:
        date_str = self._require(date_str, "Fecha del asueto")
        self._repository.delete_holiday(date_str)
        return {"date": date_str, "removed": True}

    def extract_holidays(self, payload: dict[str, Any], identity: dict[str, str]) -> dict[str, Any]:
        """Extrae un BORRADOR de asuetos desde la imagen de la publicación oficial:
        Textract (OCR, servicio AWS — sin modelos de visión, que el SCP no
        garantiza) + GLM 5 (texto → lista estructurada). El resultado NO se
        guarda: va a la pantalla de confirmación editable — el humano decide los
        casos de juicio ("corresponde al 30", "solo Capital", "a disposición")."""
        import base64
        raw = payload.get("image") or ""
        if "," in raw[:64]:  # data URL: quitar el prefijo data:image/...;base64,
            raw = raw.split(",", 1)[1]
        try:
            image_bytes = base64.b64decode(raw, validate=True)
        except Exception:
            raise ValidationError("La imagen no es válida (se espera base64).")
        if not image_bytes or len(image_bytes) > 5 * 1024 * 1024:
            raise ValidationError("La imagen debe pesar entre 1 byte y 5 MB (PNG o JPG).")

        import boto3
        try:
            ocr = boto3.client("textract", region_name="us-east-1").detect_document_text(
                Document={"Bytes": image_bytes})
        except Exception:
            raise ValidationError("No se pudo leer la imagen (Textract). Verifica que sea PNG/JPG legible.")
        lines = [b.get("Text", "") for b in ocr.get("Blocks", []) if b.get("BlockType") == "LINE"]
        text = "\n".join(lines).strip()
        if not text:
            raise ValidationError("La imagen no contiene texto legible.")

        from services.llm import LlmService
        current_year = datetime.now(UTC).year
        system = (
            "Eres un extractor de datos. Del texto OCR de una publicación oficial de asuetos de Guatemala, "
            "extrae CADA asueto como JSON. Responde SOLO un arreglo JSON válido, sin explicación, con objetos "
            '{"date":"AAAA-MM-DD","name":"...","half":true|false,"notes":"..."}. Reglas: '
            f"si el año no aparece, usa {current_year}. Usa la fecha OBSERVADA (la del día listado), y si el texto "
            'dice "corresponde al X", anótalo en notes. half=true solo para medios días. Incluye también los días '
            '"a disposición de cada entidad" con esa aclaración en notes. No inventes fechas.')
        result = LlmService().complete(text, system=system, max_tokens=1500, thinking=False)
        draft = self._parse_holiday_json(result.get("text", ""))
        if not draft:
            raise ValidationError("No se pudieron extraer asuetos del texto. Intenta con una imagen más nítida.")
        return {"draft": draft, "ocrLines": len(lines)}

    @staticmethod
    def _parse_holiday_json(text: str) -> list[dict[str, Any]]:
        """Toma el PRIMER arreglo JSON del texto del modelo y lo sanea (solo
        fechas válidas; el resto de campos se normalizan con defaults)."""
        import json
        start, end = text.find("["), text.rfind("]")
        if start < 0 or end <= start:
            return []
        try:
            data = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return []
        draft = []
        for row in data if isinstance(data, list) else []:
            if not isinstance(row, dict):
                continue
            date_str = str(row.get("date") or "").strip()
            if not _DATE_RE.match(date_str):
                continue
            draft.append({
                "date": date_str,
                "name": str(row.get("name") or "").strip()[:120] or "Asueto",
                "half": bool(row.get("half")),
                "notes": str(row.get("notes") or "").strip()[:200],
                "include": True,
            })
        return sorted(draft, key=lambda h: h["date"])

    def _normalize_holiday(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "date": item.get("date", ""),
            "name": item.get("name", ""),
            "half": bool(item.get("half")),
            "notes": item.get("notes", ""),
        }

    # ── Saldo: días hábiles (L-V) de vacaciones, partidos por año ─────────────
    @staticmethod
    def _allocated_days(person_item: dict[str, Any]) -> dict[str, int]:
        raw = person_item.get("vacationDays") or {}
        return {str(y): int(d) for y, d in raw.items()}

    def _used_vacation_days(self, absences: list[dict[str, Any]],
                            full_holidays: set[str] | None = None) -> dict[str, int]:
        """Días hábiles L-V, EXCLUYENDO asuetos completos (catálogo HOLIDAY):
        si las vacaciones cruzan un asueto, ese día no descuenta del saldo."""
        full_holidays = full_holidays or set()
        used: dict[str, int] = {}
        for absence in absences:
            if absence["type"] != "vacation":
                continue
            for day in self._iter_days(absence["startDate"], absence["endDate"]):
                if day.weekday() < 5 and day.isoformat() not in full_holidays:
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
