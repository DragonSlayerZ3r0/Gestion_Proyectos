import os
from typing import Any

import boto3


class BaseRepository:
    """Acceso compartido a la tabla única de DynamoDB. Los repos de cada dominio
    heredan de aquí; así el detalle de conexión vive en un solo lugar."""

    def __init__(self) -> None:
        self._table = boto3.resource("dynamodb").Table(os.environ["MAIN_TABLE_NAME"])

    def _update(self, key: dict[str, str], values: dict[str, Any], return_values: str = "ALL_NEW") -> dict[str, Any]:
        """UpdateItem genérico con alias `#campo` (maneja palabras reservadas como
        `role`/`status`/`location`). `values` ya debe traer lo que se quiere setear."""
        names: dict[str, str] = {}
        parts: list[str] = []
        expr_values: dict[str, Any] = {}
        for field, value in values.items():
            names[f"#{field}"] = field
            expr_values[f":{field}"] = value
            parts.append(f"#{field} = :{field}")
        response = self._table.update_item(
            Key=key,
            UpdateExpression=f"SET {', '.join(parts)}",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=expr_values,
            ReturnValues=return_values,
        )
        return response.get("Attributes", {})
