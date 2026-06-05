from typing import Any


def get_claims(event: dict[str, Any]) -> dict[str, Any]:
    authorizer = event.get("requestContext", {}).get("authorizer", {})
    jwt = authorizer.get("jwt", {})
    return jwt.get("claims", {}) or {}


def get_user_identity(event: dict[str, Any]) -> dict[str, str]:
    claims = get_claims(event)
    email = (claims.get("email") or claims.get("username") or "").strip().lower()
    subject = (claims.get("sub") or "").strip()

    if not email:
      raise ValueError("JWT no incluye email.")

    return {
        "userId": email,
        "email": email,
        "subject": subject
    }

