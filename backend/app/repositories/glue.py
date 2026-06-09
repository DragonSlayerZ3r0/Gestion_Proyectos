import boto3
from typing import Any


class GlueRepository:
    def __init__(self) -> None:
        self._client = boto3.client("glue")

    def list_databases(self) -> list[dict[str, Any]]:
        databases: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {}
        while True:
            response = self._client.get_databases(**kwargs)
            databases.extend(response.get("DatabaseList", []))
            next_token = response.get("NextToken")
            if not next_token:
                break
            kwargs["NextToken"] = next_token
        return databases

    def list_tables(self, database: str) -> list[dict[str, Any]]:
        tables: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"DatabaseName": database}
        while True:
            response = self._client.get_tables(**kwargs)
            tables.extend(response.get("TableList", []))
            next_token = response.get("NextToken")
            if not next_token:
                break
            kwargs["NextToken"] = next_token
        return tables

    def get_table(self, database: str, table: str) -> dict[str, Any] | None:
        try:
            response = self._client.get_table(DatabaseName=database, Name=table)
            return response.get("Table")
        except self._client.exceptions.EntityNotFoundException:
            return None
