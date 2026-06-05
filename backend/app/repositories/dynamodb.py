import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key


class MainTableRepository:
    def __init__(self) -> None:
        table_name = os.environ["MAIN_TABLE_NAME"]
        self._table = boto3.resource("dynamodb").Table(table_name)

    def get_user_profile(self, user_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={
                "PK": f"USER#{user_id}",
                "SK": "PROFILE"
            }
        )
        return response.get("Item")

    def list_user_modules(self, user_id: str) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"USER#{user_id}") & Key("SK").begins_with("MODULE#")
        )
        return response.get("Items", [])

