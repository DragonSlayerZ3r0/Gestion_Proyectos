from datetime import datetime, timezone
from typing import Any

from repositories.base import BaseRepository

_TTL_DAYS = 7   # los reportes son artefactos puntuales; expiran solos


class ExecReportRepository(BaseRepository):
    """Reportes ejecutivos generados por el LLM. PK=WSREPORT#<userId>, SK=<reportId>.
    Por usuario (cada quien sondea el suyo) y con TTL: no son historial permanente."""

    def _key(self, user_id: str, report_id: str) -> dict[str, str]:
        return {"PK": f"WSREPORT#{user_id}", "SK": report_id}

    def get_report(self, user_id: str, report_id: str) -> dict[str, Any] | None:
        return self._table.get_item(Key=self._key(user_id, report_id)).get("Item")

    def put_report(self, user_id: str, report_id: str, prompt: str, status: str, created_at: str) -> None:
        self._table.put_item(Item={
            **self._key(user_id, report_id), "entityType": "WS_REPORT",
            "prompt": prompt, "status": status, "createdAt": created_at,
            "ttl": int(datetime.now(timezone.utc).timestamp()) + _TTL_DAYS * 86400,
        })

    def finish_report(self, user_id: str, report_id: str, report_md: str,
                      diagram: dict[str, Any] | None, generated_at: str,
                      status: str = "ready") -> None:
        values: dict[str, Any] = {"status": status, "report": report_md, "generatedAt": generated_at}
        if diagram is not None:
            values["diagram"] = diagram
        self._update(self._key(user_id, report_id), values)
