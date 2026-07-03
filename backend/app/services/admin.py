from datetime import datetime, timezone
from typing import Any

from modules.manifest import (DEFAULT_NEW_USER_KEYS, HOME_TAB_KEYS, HOME_TABS,
                              MODULES, admin_module_groups)
from repositories.users import UsersRepository
from services.workspace import ValidationError


# Catálogo de módulos asignables y su etiqueta visible (módulos de menú +
# pestañas granulares de Inicio). Fuente única: el manifiesto.
MODULE_LABELS = {m["key"]: m["label"] for m in (MODULES + HOME_TABS)}
MODULE_ORDER = {key: index for index, key in enumerate(MODULE_LABELS)}
_HOME_TAB_KEYS = set(HOME_TAB_KEYS)

VALID_STATUSES = {"active", "inactive"}
VALID_ROLES = {"admin", "user"}


class AdminService:
    def __init__(self, repository: UsersRepository | None = None) -> None:
        self._repository = repository or UsersRepository()

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    def _normalize_email(self, value: Any) -> str:
        email = (value or "").strip().lower()
        if not email or "@" not in email:
            raise ValidationError("Email inválido.")
        return email

    def _normalize_modules(self, value: Any) -> list[str]:
        if not isinstance(value, list):
            raise ValidationError("Los módulos deben ser una lista.")
        modules = [m for m in value if m in MODULE_LABELS]
        if not modules:
            raise ValidationError("Selecciona al menos un módulo válido.")
        # 'home' siempre incluido para que la app tenga punto de entrada.
        if "home" not in modules:
            modules.append("home")
        return sorted(set(modules), key=lambda m: MODULE_ORDER.get(m, 99))

    def _normalize_role(self, value: Any) -> str:
        role = (value or "user").strip().lower()
        if role not in VALID_ROLES:
            raise ValidationError("Rol inválido.")
        return role

    def _normalize_status(self, value: Any) -> str:
        status = (value or "active").strip().lower()
        if status not in VALID_STATUSES:
            raise ValidationError("Estado inválido.")
        return status

    def list_users(self) -> dict[str, Any]:
        items = self._repository.list_all_user_items()
        by_user: dict[str, dict[str, Any]] = {}
        for item in items:
            user_id = item["PK"].split("USER#", 1)[1]
            entry = by_user.setdefault(user_id, {"profile": None, "modules": []})
            if item.get("SK") == "PROFILE":
                entry["profile"] = item
            elif str(item.get("SK", "")).startswith("MODULE#"):
                entry["modules"].append(item)

        users = []
        for user_id, entry in by_user.items():
            profile = entry["profile"] or {}
            enabled_modules = sorted(
                [m["moduleKey"] for m in entry["modules"] if m.get("enabled")],
                key=lambda m: MODULE_ORDER.get(m, 99),
            )
            roles = profile.get("roles", ["user"])
            users.append({
                "id": user_id,
                "email": profile.get("email", user_id),
                "name": profile.get("name", user_id),
                "status": profile.get("status", "active"),
                "role": "admin" if "admin" in roles else "user",
                "modules": enabled_modules,
                "configured": entry["profile"] is not None,
                "createdAt": profile.get("createdAt", ""),
                "updatedAt": profile.get("updatedAt", ""),
            })
        users.sort(key=lambda u: u["email"])
        return {
            "users": users,
            "availableModules": [{"key": k, "label": v} for k, v in MODULE_LABELS.items()],
            # Matriz de asignación derivada del manifiesto (fuente única): el
            # frontend pinta las casillas desde aquí — módulo/pestaña nuevo en el
            # manifiesto aparece solo, sin tocar admin.ts.
            "moduleGroups": admin_module_groups(),
            "defaultNewUserKeys": DEFAULT_NEW_USER_KEYS,
        }

    def create_user(self, payload: dict[str, Any]) -> dict[str, Any]:
        email = self._normalize_email(payload.get("email"))
        if self._repository.get_user_profile(email) is not None:
            raise ValidationError("Ya existe un usuario con ese email.")
        name = (payload.get("name") or "").strip() or email
        role = self._normalize_role(payload.get("role"))
        status = self._normalize_status(payload.get("status"))
        modules = self._normalize_modules(payload.get("modules"))
        now = self._now()
        roles = ["admin", "user"] if role == "admin" else ["user"]

        self._repository.put_user_profile(email, {
            "email": email, "name": name, "roles": roles,
            "status": status, "createdAt": now, "updatedAt": now,
        })
        # Escribe todo el catálogo (habilitado/deshabilitado) para que la
        # resolución de pestañas de Inicio sea determinista desde el alta.
        wanted = set(modules)
        for module_key in MODULE_LABELS:
            self._repository.put_user_module(
                email, module_key, MODULE_LABELS[module_key],
                module_key in wanted, now,
            )

        return self._format_user(email, name, email, status, role, modules, now, now)

    def update_user(self, email: str, payload: dict[str, Any]) -> dict[str, Any]:
        email = self._normalize_email(email)
        existing = self._repository.get_user_profile(email)
        if existing is None:
            raise ValidationError("El usuario no existe.")
        now = self._now()

        profile_updates: dict[str, Any] = {"updatedAt": now}
        if "name" in payload:
            profile_updates["name"] = (payload.get("name") or "").strip() or email
        if "role" in payload:
            role = self._normalize_role(payload.get("role"))
            profile_updates["roles"] = ["admin", "user"] if role == "admin" else ["user"]
        if "status" in payload:
            profile_updates["status"] = self._normalize_status(payload.get("status"))
        updated_profile = self._repository.update_user_profile_fields(email, profile_updates)

        if "modules" in payload:
            modules = self._normalize_modules(payload.get("modules"))
            wanted = set(modules)
            # Habilita los pedidos y deshabilita el resto del catálogo.
            for module_key in MODULE_LABELS:
                self._repository.put_user_module(
                    email, module_key, MODULE_LABELS[module_key],
                    module_key in wanted, now,
                )

        module_items = self._repository.list_user_modules(email)
        enabled_modules = sorted(
            [m["moduleKey"] for m in module_items if m.get("enabled")],
            key=lambda m: MODULE_ORDER.get(m, 99),
        )
        roles = updated_profile.get("roles", ["user"])
        return self._format_user(
            email, updated_profile.get("name", email), updated_profile.get("email", email),
            updated_profile.get("status", "active"),
            "admin" if "admin" in roles else "user",
            enabled_modules,
            updated_profile.get("createdAt", ""), now,
        )

    def delete_user(self, email: str, caller_email: str = "") -> dict[str, Any]:
        email = self._normalize_email(email)
        if email == (caller_email or "").strip().lower():
            raise ValidationError("No puedes eliminar tu propio usuario.")
        # Borra perfil + módulos aunque el perfil ya no exista (limpia huérfanos).
        self._repository.delete_user(email)
        return {"email": email, "removed": True}

    def _format_user(self, user_id, name, email, status, role, modules, created_at, updated_at) -> dict[str, Any]:
        return {
            "id": user_id, "email": email, "name": name, "status": status,
            "role": role, "modules": modules, "configured": True,
            "createdAt": created_at, "updatedAt": updated_at,
        }
