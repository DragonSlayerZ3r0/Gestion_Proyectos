from typing import Any

from boto3.dynamodb.conditions import Key

from repositories.base import BaseRepository


class UsersRepository(BaseRepository):
    """Perfiles de usuario y módulos habilitados (autenticación/autorización)."""

    def get_user_profile(self, user_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": f"USER#{user_id}", "SK": "PROFILE"})
        return response.get("Item")

    def list_user_modules(self, user_id: str) -> list[dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression=Key("PK").eq(f"USER#{user_id}") & Key("SK").begins_with("MODULE#"))

    def list_all_user_items(self) -> list[dict[str, Any]]:
        """Todos los items USER# (PROFILE + MODULE#) para el módulo admin. Dos
        queries por el GSI de entidad (perfiles + módulos) en vez de escanear la
        tabla; excluye de paso las sesiones de chat que comparten el PK USER#."""
        return self._query_entity_type("USER") + self._query_entity_type("USER_MODULE")

    def put_user_profile(self, user_id: str, item: dict[str, Any]) -> None:
        item["PK"] = f"USER#{user_id}"
        item["SK"] = "PROFILE"
        item["entityType"] = "USER"
        self._table.put_item(Item=item)

    def update_user_profile_fields(self, user_id: str, values: dict[str, Any]) -> dict[str, Any]:
        return self._update({"PK": f"USER#{user_id}", "SK": "PROFILE"}, values)

    def delete_user(self, user_id: str) -> None:
        """Borra el perfil y TODOS los items MODULE# del usuario (sin huérfanos)."""
        items = self._query_all(KeyConditionExpression=Key("PK").eq(f"USER#{user_id}"))
        with self._table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

    def put_user_module(self, user_id: str, module_key: str, label: str, enabled: bool, now: str) -> None:
        self._table.put_item(Item={
            "PK": f"USER#{user_id}", "SK": f"MODULE#{module_key}",
            "entityType": "USER_MODULE",
            "moduleKey": module_key, "label": label, "enabled": enabled,
            "createdAt": now, "updatedAt": now,
        })
