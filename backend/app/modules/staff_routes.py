from core.request import Request
from core.router import Router
from responses import success
from services.staff import StaffService


def _get_staff(req: Request):
    return success(StaffService().get_staff(req.identity))


def _create_absence(req: Request):
    person_id = req.params.get("personId") or ""
    return success(StaffService().create_absence(person_id, req.body(), req.identity), 201)


def _absence_update(req: Request):
    service = StaffService()
    person_id = req.params.get("personId") or ""
    absence_id = req.params.get("absenceId") or ""
    if req.method == "DELETE":
        return success(service.delete_absence(person_id, absence_id, req.identity))
    return success(service.update_absence(person_id, absence_id, req.body(), req.identity))


def _set_vacation_days(req: Request):
    person_id = req.params.get("personId") or ""
    return success(StaffService().set_vacation_days(person_id, req.body(), req.identity))


def _set_notes(req: Request):
    person_id = req.params.get("personId") or ""
    return success(StaffService().set_notes(person_id, req.body(), req.identity))


def _save_holidays(req: Request):
    return success(StaffService().save_holidays(req.body(), req.identity), 201)


def _delete_holiday(req: Request):
    return success(StaffService().delete_holiday(req.params.get("date") or "", req.identity))


def _extract_holidays(req: Request):
    return success(StaffService().extract_holidays(req.body(), req.identity))


def register(router: Router) -> None:
    # Lectura: cualquier usuario autenticado Y configurado (el servicio valida el
    # perfil; no exige módulo — la vista se abre desde el menú del usuario).
    router.add(["GET"], "/api/staff", _get_staff,
               error_msg="Error inesperado al cargar el personal.")
    # Escritura: SOLO administradores (guard admin=True, validado en backend).
    router.add(["POST"], "/api/staff/people/{personId}/absences", _create_absence, admin=True,
               error_msg="Error inesperado al registrar la ausencia.")
    router.add(["PATCH", "DELETE"], "/api/staff/people/{personId}/absences/{absenceId}", _absence_update, admin=True,
               error_msg="Error inesperado al actualizar la ausencia.")
    router.add(["PATCH"], "/api/staff/people/{personId}/vacation-days", _set_vacation_days, admin=True,
               error_msg="Error inesperado al asignar los días de vacaciones.")
    router.add(["PATCH"], "/api/staff/people/{personId}/notes", _set_notes, admin=True,
               error_msg="Error inesperado al guardar la nota.")
    router.add(["POST"], "/api/staff/holidays", _save_holidays, admin=True,
               error_msg="Error inesperado al guardar los asuetos.")
    router.add(["DELETE"], "/api/staff/holidays/{date}", _delete_holiday, admin=True,
               error_msg="Error inesperado al eliminar el asueto.")
    router.add(["POST"], "/api/staff/holidays/extract", _extract_holidays, admin=True,
               error_msg="Error inesperado al extraer los asuetos de la imagen.")
