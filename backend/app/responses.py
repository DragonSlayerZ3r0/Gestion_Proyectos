import json
from typing import Any


DEFAULT_HEADERS = {
    "content-type": "application/json",
    "cache-control": "no-store"
}


def success(data: Any, status_code: int = 200) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": DEFAULT_HEADERS,
        "body": json.dumps({
            "ok": True,
            "data": data,
            "error": None
        }, ensure_ascii=False)
    }


def error(code: str, message: str, status_code: int) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": DEFAULT_HEADERS,
        "body": json.dumps({
            "ok": False,
            "data": None,
            "error": {
                "code": code,
                "message": message
            }
        }, ensure_ascii=False)
    }

