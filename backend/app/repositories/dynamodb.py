import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key


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

    def list_people(self) -> list[dict[str, Any]]:
        response = self._table.scan(
            FilterExpression=Attr("entityType").eq("PERSON")
        )
        return response.get("Items", [])

    def list_projects(self) -> list[dict[str, Any]]:
        response = self._table.scan(
            FilterExpression=Attr("entityType").eq("PROJECT")
        )
        return response.get("Items", [])

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={
                "PK": f"PROJECT#{project_id}",
                "SK": "META"
            }
        )
        return response.get("Item")

    def list_project_members(self, project_id: str) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}") & Key("SK").begins_with("PERSON#")
        )
        return response.get("Items", [])

    def list_project_tasks(self, project_id: str) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"PROJECT#{project_id}") & Key("SK").begins_with("TASK#")
        )
        return response.get("Items", [])

    def get_task(self, project_id: str, task_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={
                "PK": f"PROJECT#{project_id}",
                "SK": f"TASK#{task_id}"
            }
        )
        return response.get("Item")

    def put_item(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)

    def put_audit_event(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)

    def update_person(self, person_id: str, values: dict[str, Any]) -> dict[str, Any]:
        names = {"#updatedAt": "updatedAt"}
        expression_parts = ["#updatedAt = :updatedAt"]
        expression_values = {":updatedAt": values["updatedAt"]}

        for key, value in values.items():
            if key == "updatedAt":
                continue
            names[f"#{key}"] = key
            expression_values[f":{key}"] = value
            expression_parts.append(f"#{key} = :{key}")

        response = self._table.update_item(
            Key={
                "PK": f"PERSON#{person_id}",
                "SK": "PROFILE"
            },
            UpdateExpression=f"SET {', '.join(expression_parts)}",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=expression_values,
            ReturnValues="ALL_NEW"
        )
        return response["Attributes"]

    def update_project(self, project_id: str, values: dict[str, Any]) -> dict[str, Any]:
        names = {"#updatedAt": "updatedAt"}
        expression_parts = ["#updatedAt = :updatedAt"]
        expression_values = {":updatedAt": values["updatedAt"]}

        for key, value in values.items():
            if key == "updatedAt":
                continue
            names[f"#{key}"] = key
            expression_values[f":{key}"] = value
            expression_parts.append(f"#{key} = :{key}")

        response = self._table.update_item(
            Key={
                "PK": f"PROJECT#{project_id}",
                "SK": "META"
            },
            UpdateExpression=f"SET {', '.join(expression_parts)}",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=expression_values,
            ReturnValues="ALL_NEW"
        )
        return response["Attributes"]

    def update_project_member_role(self, project_id: str, person_id: str, role: str, values: dict[str, str]) -> dict[str, Any]:
        response = self._table.update_item(
            Key={
                "PK": f"PROJECT#{project_id}",
                "SK": f"PERSON#{person_id}"
            },
            UpdateExpression="SET #role = :role, updatedAt = :updatedAt, updatedBy = :updatedBy",
            ExpressionAttributeNames={
                "#role": "role"
            },
            ExpressionAttributeValues={
                ":role": role,
                ":updatedAt": values["updatedAt"],
                ":updatedBy": values["updatedBy"]
            },
            ReturnValues="ALL_NEW"
        )
        return response["Attributes"]

    # ── Catálogo caché ──────────────────────────────────────────────────────────

    def get_catalog_sync_meta(self) -> dict[str, Any] | None:
        response = self._table.get_item(Key={"PK": "CATALOG#SYNC", "SK": "META"})
        return response.get("Item")

    def put_catalog_sync_meta(self, synced_at: str, status: str) -> None:
        self._table.put_item(Item={
            "PK": "CATALOG#SYNC", "SK": "META",
            "entityType": "CATALOG_SYNC", "syncedAt": synced_at, "status": status,
        })

    def list_catalog_databases(self) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq("CATALOG#DB")
        )
        return response.get("Items", [])

    def put_catalog_database(self, database: str, table_count: int, synced_at: str, description: str = "") -> None:
        self._table.put_item(Item={
            "PK": "CATALOG#DB", "SK": database,
            "entityType": "CATALOG_DB",
            "database": database, "description": description,
            "tableCount": table_count, "syncedAt": synced_at,
        })

    def list_catalog_tables(self, database: str) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"CATALOG#{database}") & Key("SK").begins_with("TABLE#"),
            ProjectionExpression="#n, #db, tableType, description, columnCount, syncedAt, SK",
            ExpressionAttributeNames={"#n": "name", "#db": "database"},
        )
        return response.get("Items", [])

    def get_catalog_table(self, database: str, table: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={"PK": f"CATALOG#{database}", "SK": f"TABLE#{table}"}
        )
        return response.get("Item")

    def put_catalog_table(self, item: dict[str, Any]) -> None:
        self._table.put_item(Item=item)

    # ── Contexto funcional ───────────────────────────────────────────────────────

    def get_table_context(self, database: str, table_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={"PK": f"TABLE#{database}#{table_name}", "SK": "CONTEXT"}
        )
        return response.get("Item")

    def list_column_contexts(self, database: str, table_name: str) -> list[dict[str, Any]]:
        response = self._table.query(
            KeyConditionExpression=Key("PK").eq(f"TABLE#{database}#{table_name}") & Key("SK").begins_with("COLUMN#")
        )
        return response.get("Items", [])

    def get_column_context(self, database: str, table_name: str, column_name: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={"PK": f"TABLE#{database}#{table_name}", "SK": f"COLUMN#{column_name}"}
        )
        return response.get("Item")

    def delete_project_member(self, project_id: str, person_id: str) -> None:
        self._table.delete_item(
            Key={
                "PK": f"PROJECT#{project_id}",
                "SK": f"PERSON#{person_id}"
            }
        )

    def update_task(self, project_id: str, task_id: str, values: dict[str, Any]) -> dict[str, Any]:
        names = {"#updatedAt": "updatedAt"}
        expression_parts = ["#updatedAt = :updatedAt"]
        expression_values = {":updatedAt": values["updatedAt"]}

        for key, value in values.items():
            if key == "updatedAt":
                continue
            names[f"#{key}"] = key
            expression_values[f":{key}"] = value
            expression_parts.append(f"#{key} = :{key}")

        response = self._table.update_item(
            Key={
                "PK": f"PROJECT#{project_id}",
                "SK": f"TASK#{task_id}"
            },
            UpdateExpression=f"SET {', '.join(expression_parts)}",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=expression_values,
            ReturnValues="ALL_NEW"
        )
        return response["Attributes"]
