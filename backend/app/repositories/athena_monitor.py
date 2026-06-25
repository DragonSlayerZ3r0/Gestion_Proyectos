from typing import Any

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository

_PK = "HOME#ATHENA"


class AthenaMonitorRepository(BaseRepository):
    """Caché del monitoreo de consumo de Athena por usuario (por ventana de fechas).

    SK = <inicio>#<fin>  → agregado por usuario + top consultas + estado/scannedAt.
    """

    def _sk(self, start: str, end: str) -> str:
        return f"{start}#{end}"

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
