"""Excepciones de dominio compartidas (kernel). Cada capa las lanza y el router
las traduce a respuestas HTTP en un solo lugar."""


class ValidationError(Exception):
    """Entrada inválida del cliente → HTTP 400."""


class UserNotConfiguredError(Exception):
    """Usuario autenticado sin perfil funcional → HTTP 403 USER_NOT_CONFIGURED."""
