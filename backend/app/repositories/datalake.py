from typing import Any

from repositories.base import BaseRepository

_PK = "DATALAKE#INGEST"


class DatalakeRepository(BaseRepository):
    """Caché del monitoreo de cargas del data lake (histogramas por día).

    - Overview por bucket: SK = <bucket>  → totales por zona y por día + estado.
    - Detalle por zona:    SK = <bucket>#detail#<zona>  → por área, por día.
    """

    def get_overview(self, bucket: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": _PK, "SK": bucket})
        return response.get("Item")

    def put_overview(self, bucket: str, data: dict[str, Any], scanned_at: str, status: str) -> None:
        self._table.put_item(Item={
            "PK": _PK, "SK": bucket, "entityType": "DATALAKE_INGEST",
            "data": data, "scannedAt": scanned_at, "status": status, "startedAt": scanned_at,
        })

    def set_status(self, bucket: str, status: str, started_at: str) -> None:
        """Marca estado sin pisar data/scannedAt (upsert). `status` es palabra
        reservada → _update usa alias #status."""
        self._update({"PK": _PK, "SK": bucket}, {"status": status, "startedAt": started_at})

    def get_zone_detail(self, bucket: str, zone: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": _PK, "SK": f"{bucket}#detail#{zone}"})
        return response.get("Item")

    def put_zone_detail(self, bucket: str, zone: str, data: dict[str, Any]) -> None:
        self._table.put_item(Item={
            "PK": _PK, "SK": f"{bucket}#detail#{zone}",
            "entityType": "DATALAKE_INGEST_DETAIL", "data": data,
        })
