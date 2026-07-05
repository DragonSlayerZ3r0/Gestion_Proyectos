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

    def list_usage_windows(self) -> list[dict[str, Any]]:
        """Metadatos (sin `data`, que pesa) de todas las ventanas cacheadas — para
        elegir una ventana previa como respaldo mientras se calcula una nueva."""
        items = self._query_all(
            KeyConditionExpression=Key("PK").eq(_PK),
            ProjectionExpression="SK, #st, scannedAt",
            ExpressionAttributeNames={"#st": "status"})
        return [i for i in items
                if "#ap#" not in i.get("SK", "") and i.get("SK") not in ("NAMEMAP", "INGEST")]

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

    # ── Ingesta incremental: ejecuciones crudas + cursor de lo ya ingerido ─────
    # Un item por ejecución (PK=ATHENA#EXEC, SK=<submission>#<qid>) con el lint ya
    # calculado. El agregado por ventana se recalcula desde aquí SIN volver a
    # CloudTrail/Athena ni re-parsear — los escaneos siguientes solo traen lo nuevo.
    def get_ingest_cursor(self) -> dict[str, Any] | None:
        return self._table.get_item(Key={"PK": _PK, "SK": "INGEST"}).get("Item")

    def put_ingest_cursor(self, ingested_from: str, ingested_to: str, now: str) -> None:
        self._table.put_item(Item={
            "PK": _PK, "SK": "INGEST", "entityType": "HOME_ATHENA_INGEST",
            "from": ingested_from, "to": ingested_to, "updatedAt": now,
        })

    def put_executions(self, items: list[dict[str, Any]]) -> None:
        with self._table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
            for item in items:
                batch.put_item(Item=item)

    def query_executions(self, start: str, end: str) -> list[dict[str, Any]]:
        """Ejecuciones guardadas cuyo SubmissionDateTime cae en [start, end] (el SK
        empieza con el ISO de la ejecución; '~' > 'T' cierra el rango del día)."""
        return self._query_all(
            KeyConditionExpression=Key("PK").eq("ATHENA#EXEC") & Key("SK").between(start, end + "~"))

    # Mapa actor(email) -> nombre real (Identity Center), compartido entre ventanas.
    def get_name_map(self) -> dict[str, str]:
        item = self._table.get_item(Key={"PK": _PK, "SK": "NAMEMAP"}).get("Item")
        return dict((item or {}).get("names") or {})

    def put_name_map(self, names: dict[str, str]) -> None:
        self._table.put_item(Item={"PK": _PK, "SK": "NAMEMAP", "entityType": "HOME_ATHENA_NAMES", "names": names})
