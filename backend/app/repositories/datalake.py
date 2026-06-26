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

    # ── Registros (conteo de filas parquet) cacheado por rango ────────────────
    # SK = <bucket>#records#<zona>#<inicio>#<fin>
    def _records_sk(self, bucket: str, zone: str, start: str, end: str) -> str:
        return f"{bucket}#records#{zone}#{start}#{end}"

    def get_records(self, bucket: str, zone: str, start: str, end: str) -> dict[str, Any] | None:
        sk = self._records_sk(bucket, zone, start, end)
        return self._table.get_item(Key={"PK": _PK, "SK": sk}).get("Item")

    def put_records(self, bucket: str, zone: str, start: str, end: str,
                    data: dict[str, Any], scanned_at: str, status: str) -> None:
        self._table.put_item(Item={
            "PK": _PK, "SK": self._records_sk(bucket, zone, start, end),
            "entityType": "DATALAKE_INGEST_RECORDS",
            "data": data, "scannedAt": scanned_at, "status": status, "startedAt": scanned_at,
        })

    def set_records_status(self, bucket: str, zone: str, start: str, end: str,
                           status: str, started_at: str) -> None:
        self._update({"PK": _PK, "SK": self._records_sk(bucket, zone, start, end)},
                     {"status": status, "startedAt": started_at})

    # ── Tablas de un (área, día) bajo demanda (drill Por fecha → área → tablas) ─
    # SK = <bucket>#recdaytbl#<zona>#<area>#<dia>; items pequeños, uno por drill.
    def _day_tables_sk(self, bucket: str, zone: str, area: str, day: str) -> str:
        return f"{bucket}#recdaytbl#{zone}#{area}#{day}"

    def get_day_tables(self, bucket: str, zone: str, area: str, day: str) -> dict[str, Any] | None:
        sk = self._day_tables_sk(bucket, zone, area, day)
        return self._table.get_item(Key={"PK": _PK, "SK": sk}).get("Item")

    def put_day_tables(self, bucket: str, zone: str, area: str, day: str,
                       data: list[dict[str, Any]], scanned_at: str) -> None:
        self._table.put_item(Item={
            "PK": _PK, "SK": self._day_tables_sk(bucket, zone, area, day),
            "entityType": "DATALAKE_INGEST_RECDAYTBL", "data": data, "scannedAt": scanned_at,
        })
