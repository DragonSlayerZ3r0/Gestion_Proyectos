from typing import Any

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository


class StaffRepository(BaseRepository):
    """Gestión de personal: ausencias (PERSON_ABSENCE) colgando de las MISMAS
    personas del workspace (PK=PERSON#) + saldo de vacaciones en su perfil."""

    def list_people(self) -> list[dict[str, Any]]:
        return self._query_entity_type("PERSON")

    def get_person(self, person_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"PERSON#{person_id}", "SK": "PROFILE"})
        return response.get("Item")

    def update_person(self, person_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PERSON#{person_id}", "SK": "PROFILE"}, values)

    # ── Ausencias ─────────────────────────────────────────────────────────────
    def list_all_absences(self) -> list[dict[str, Any]]:
        return self._query_entity_type("PERSON_ABSENCE")

    def list_person_absences(self, person_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"PERSON#{person_id}") & Key("SK").begins_with("ABSENCE#"))

    def get_absence(self, person_id: str, absence_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"PERSON#{person_id}", "SK": f"ABSENCE#{absence_id}"})
        return response.get("Item")

    def update_absence(self, person_id: str, absence_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"PERSON#{person_id}", "SK": f"ABSENCE#{absence_id}"}, values)

    def delete_absence(self, person_id: str, absence_id: str) -> None:
        self._table.delete_item(Key={"PK": f"PERSON#{person_id}", "SK": f"ABSENCE#{absence_id}"})

    # ── Asuetos (catálogo HOLIDAY: días festivos autorizados) ─────────────────
    def list_holidays(self) -> list[dict[str, Any]]:
        return self._query_entity_type("HOLIDAY")

    def delete_holiday(self, date: str) -> None:
        self._table.delete_item(Key={"PK": f"HOLIDAY#{date}", "SK": "PROFILE"})

    def put_item(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)
