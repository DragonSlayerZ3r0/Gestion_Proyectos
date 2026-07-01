from typing import Any

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository

_PK = "HOME#ATHENA"


class AthenaMonitorRepository(BaseRepository):
    """Caché del monitoreo de consumo de Athena por usuario (por ventana de fechas).

    SK = <inicio>#<fin>           → agregado por usuario + top consultas + estado/scannedAt.
    SK = <inicio>#<fin>#ap#<user> → consultas con antipatrones de ESE usuario (drill).
    """

    def _sk(self, start: str, end: str) -> str:
        return f"{start}#{end}"

    def _sk_ap(self, start: str, end: str, user: str) -> str:
        return f"{start}#{end}#ap#{user}"

    def get_usage(self, start: str, end: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": _PK, "SK": self._sk(start, end)}).get("Item")

    def put_usage(self, start: str, end: str, data: dict[str, Any], scanned_at: str, status: str) -> None:
        self._table.put_item(Item={
            "PK": _PK, "SK": self._sk(start, end), "entityType": "HOME_ATHENA",
            "data": data, "scannedAt": scanned_at, "status": status, "startedAt": scanned_at,
        })

    def set_status(self, start: str, end: str, status: str, started_at: str) -> None:
        self._update({"PK": _PK, "SK": self._sk(start, end)},
                     {"status": status, "startedAt": started_at})

    def put_user_antipatterns(self, start: str, end: str, user_ap: dict[str, list], scanned_at: str) -> None:
        """Un item por usuario con sus consultas con antipatrones (drill bajo demanda).
        Mantiene el item principal pequeño y escala con la cantidad de usuarios."""
        for user, queries in (user_ap or {}).items():
            self._table.put_item(Item={
                "PK": _PK, "SK": self._sk_ap(start, end, user), "entityType": "HOME_ATHENA_AP",
                "queries": queries, "scannedAt": scanned_at,
            })

    def get_user_antipatterns(self, start: str, end: str, user: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": _PK, "SK": self._sk_ap(start, end, user)}).get("Item")

    # Mapa actor(email) -> nombre real (Identity Center), compartido entre ventanas.
    def get_name_map(self) -> dict[str, str]:
        item = self._table.get_item(Key={"PK": _PK, "SK": "NAMEMAP"}).get("Item")
        return dict((item or {}).get("names") or {})

    def put_name_map(self, names: dict[str, str]) -> None:
        self._table.put_item(Item={"PK": _PK, "SK": "NAMEMAP", "entityType": "HOME_ATHENA_NAMES", "names": names})
