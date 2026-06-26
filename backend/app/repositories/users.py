from typing import Any

from boto3.dynamodb.conditions import Attr, Key

from repositories.base import BaseRepository


class UsersRepository(BaseRepository):
    """Perfiles de usuario y módulos habilitados (autenticación/autorización)."""

    def get_user_profile(self, user_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"USER#{user_id}", "SK": "PROFILE"})
        return response.get("Item")

    def list_user_modules(self, user_id: str) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"USER#{user_id}") & Key("SK").begins_with("MODULE#")
        )
        return response.get("Items", [])

    def list_all_user_items(self) -> list[dict[str, Any]]:
        """Todos los items USER# (PROFILE + MODULE#) para el módulo admin."""
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"FilterExpression": Attr("PK").begins_with("USER#")}
        while True:
            response = self._table.scan(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                break
            kwargs["ExclusiveStartKey"] = last_key
        return items

    def put_user_profile(self, user_id: str, item: dict[str, Any]) -> None:
        item["PK"] = f"USER#{user_id}"
        item["SK"] = "PROFILE"
        item["entityType"] = "USER"
        self._table.put_item(Item=item)

    def update_user_profile_fields(self, user_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"USER#{user_id}", "SK": "PROFILE"}, values)

    def delete_user(self, user_id: str) -> None:
        """Borra el perfil y TODOS los items MODULE# del usuario (sin huérfanos)."""
        response = self._table.query(KeyConditionExpression=Key("PK").eq(f"USER#{user_id}"))
        with self._table.batch_writer() as batch:
            for item in response.get("Items", []):
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

    def put_user_module(self, user_id: str, module_key: str, label: str, enabled: bool, now: str) -> None:
        self._table.put_item(Item={
            "PK": f"USER#{user_id}", "SK": f"MODULE#{module_key}",
            "entityType": "USER_MODULE",
            "moduleKey": module_key, "label": label, "enabled": enabled,
            "createdAt": now, "updatedAt": now,
        })
