// @ts-nocheck
// Personal (staff): ausencias del equipo + saldo simple de vacaciones.
// NO es un módulo del menú lateral: se abre desde el menú del usuario (arriba de
// "Salir"). Cualquier usuario configurado puede VER; solo administradores
// registran/editan (el backend lo valida con guard admin — la UI solo lo refleja).
export function createStaffModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, renderDeleteIconButton } = ctx;

  const TYPE_META = {
    vacation: { label: "Vacaciones", cls: "absVacation" },
    leave: { label: "Permiso", cls: "absLeave" },
    sick: { label: "Incapacidad", cls: "absSick" },
  };
  const typeLabel = (t) => TYPE_META[t]?.label || t;
  const typeClass = (t) => TYPE_META[t]?.cls || "";
  // Claves de tipo desde el PAYLOAD (fuente única: ABSENCE_TYPES en
  // services/staff.py); TYPE_META aporta etiqueta/color local. Un tipo nuevo en
  // el backend aparece solo en el select, la leyenda y el calendario.
  function absenceTypes() {
    const keys = state.staffData?.absenceTypes?.length ? state.staffData.absenceTypes : Object.keys(TYPE_META);
    return keys.map((k) => [k, TYPE_META[k] || { label: k, cls: "" }]);
  }

  function isAdmin() {
    return (state.profile?.user?.roles || []).includes("admin");
  }
  function todayIso() {
    // Fecha local del usuario (no UTC): "hoy" debe ser el día de Guatemala.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function addDaysIso(iso, days) {
    const d = new Date(`${iso}T00:00:00`);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function dateLabel(iso) {
    if (!iso) return "";
    return new Date(`${iso}T00:00:00`).toLocaleDateString("es-GT", { weekday: "short", day: "numeric", month: "short" });
  }

  async function render() {
    elements.statusPanel.hidden = true;
    elements.contentPanel.hidden = false;
    elements.viewTitle.textContent = "Personal";
    if (!state.staffData && !state.staffError) {
      elements.contentPanel.innerHTML = `<section class="panel staffPanel"><p class="emptyText">Cargando personal…</p></section>`;
      try {
        const payload = await apiRequest("api/staff");
        state.staffData = payload.data;
      } catch (error) {
        state.staffError = error.message;
      }
      if (state.activeModule !== "staff") return;
    }
    paint();
  }

  function paint() {
    const people = state.staffData?.people || [];
    elements.contentPanel.innerHTML = `
      <section class="staffModule">
        ${state.staffError ? `<section class="panel staffPanel"><p class="attachStatus error">${escapeHtml(state.staffError)}</p></section>` : ""}
        ${renderNowStrip(people)}
        ${people.length > 6 ? `<input id="staffSearch" class="searchInput staffSearch" type="search" placeholder="Buscar persona por nombre o área" value="${escapeAttribute(state.staffSearch || "")}" />` : ""}
        ${renderCalendar(people)}
        ${renderPeopleList(people)}
      </section>`;
    bindEvents();
    applyStaffFilter(); // reaplica el filtro vigente tras cada re-render
  }

  // Búsqueda por DOM (sin re-render → no pierde el foco del input): oculta filas
  // del calendario y de la lista cuya persona no coincide. "Fuera hoy" no se filtra
  // (es un resumen). Persiste en state.staffSearch para sobrevivir a los repintados.
  function normalizeStaff(value) {
    return (value || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }
  function applyStaffFilter() {
    const q = normalizeStaff(state.staffSearch);
    let visible = 0;
    for (const el of document.querySelectorAll("[data-staff-name]")) {
      const match = !q || el.dataset.staffName.includes(q);
      el.hidden = !match;
      if (match) visible++;
    }
    const noResults = document.querySelector("[data-staff-noresults]");
    if (noResults) noResults.hidden = !(q && visible === 0);
  }

  // ── "Ahora": quién está fuera hoy + salidas de los próximos 7 días ─────────
  function renderNowStrip(people) {
    const today = todayIso();
    const weekAhead = addDaysIso(today, 7);
    const outNow = [];
    const upcoming = [];
    for (const person of people) {
      for (const a of person.absences) {
        if (a.startDate <= today && a.endDate >= today) {
          outNow.push({ person, a });
        } else if (a.startDate > today && a.startDate <= weekAhead) {
          upcoming.push({ person, a });
        }
      }
    }
    upcoming.sort((x, y) => x.a.startDate.localeCompare(y.a.startDate));
    const chip = ({ person, a }, showStart) => `
      <span class="staffNowChip ${typeClass(a.type)}">
        <strong>${escapeHtml(person.fullName)}</strong>
        ${typeLabel(a.type)} · ${showStart ? `desde ${dateLabel(a.startDate)}` : `hasta ${dateLabel(a.endDate)}`}
      </span>`;
    return `
      <section class="panel staffPanel">
        <div class="blockHeader"><strong>Fuera hoy</strong><span>${outNow.length}</span></div>
        <div class="staffNowRow">${outNow.map((o) => chip(o, false)).join("") || `<span class="emptyText">Nadie está fuera hoy — equipo completo.</span>`}</div>
        ${upcoming.length ? `
        <div class="blockHeader staffUpcomingHead"><strong>Próximos 7 días</strong><span>${upcoming.length}</span></div>
        <div class="staffNowRow">${upcoming.map((o) => chip(o, true)).join("")}</div>` : ""}
      </section>`;
  }

  // ── Calendario del mes: fila por persona, celdas coloreadas por tipo ───────
  function currentMonth() {
    return state.staffMonth || todayIso().slice(0, 7);
  }
  function renderCalendar(people) {
    const month = currentMonth();               // "AAAA-MM"
    const [year, mon] = month.split("-").map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();
    const today = todayIso();
    const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleDateString("es-GT", { month: "long", year: "numeric" });
    const anyAbsence = people.some((p) => p.absences.length);

    const dayHead = Array.from({ length: daysInMonth }, (_, i) => {
      const iso = `${month}-${String(i + 1).padStart(2, "0")}`;
      const weekday = new Date(`${iso}T00:00:00`).getDay();
      const weekend = weekday === 0 || weekday === 6;
      return `<span class="staffCalDay ${weekend ? "weekend" : ""} ${iso === today ? "today" : ""}">${i + 1}</span>`;
    }).join("");

    const rows = people.map((person) => {
      const cells = Array.from({ length: daysInMonth }, (_, i) => {
        const iso = `${month}-${String(i + 1).padStart(2, "0")}`;
        const absence = person.absences.find((a) => a.startDate <= iso && a.endDate >= iso);
        const weekday = new Date(`${iso}T00:00:00`).getDay();
        const weekend = weekday === 0 || weekday === 6;
        const title = absence ? `${escapeAttribute(person.fullName)} · ${typeLabel(absence.type)} ${absence.startDate} → ${absence.endDate}` : "";
        return `<span class="staffCalCell ${weekend ? "weekend" : ""} ${absence ? typeClass(absence.type) : ""}" ${title ? `title="${title}"` : ""}></span>`;
      }).join("");
      return `
        <div class="staffCalRow" data-staff-name="${escapeAttribute(normalizeStaff(`${person.fullName} ${person.area || ""}`))}">
          <button type="button" class="staffCalName" data-staff-person="${person.id}" title="Ver ficha de ${escapeAttribute(person.fullName)}">${escapeHtml(person.fullName)}</button>
          <div class="staffCalCells" style="--staff-days:${daysInMonth}">${cells}</div>
        </div>`;
    }).join("");

    return `
      <section class="panel staffPanel">
        <div class="staffCalHead">
          <div class="blockHeader"><strong>Calendario</strong><span>${escapeHtml(monthLabel)}</span></div>
          <div class="staffCalNav">
            <button class="tinyButton ghost" type="button" data-staff-month="-1" aria-label="Mes anterior">‹</button>
            <button class="tinyButton ghost" type="button" data-staff-month="0">Hoy</button>
            <button class="tinyButton ghost" type="button" data-staff-month="1" aria-label="Mes siguiente">›</button>
          </div>
          <div class="staffLegend">
            ${absenceTypes().map(([k, m]) => `<span class="staffLegendItem"><span class="staffCalCell ${m.cls}"></span>${m.label}</span>`).join("")}
          </div>
        </div>
        ${people.length && !anyAbsence ? `<p class="staffCalHint">El calendario está vacío porque aún no se ha registrado ninguna ausencia. ${isAdmin() ? "Abre una persona abajo y usa “+ Registrar ausencia”." : "Solo los administradores registran ausencias."}</p>` : ""}
        <div class="staffCalScroll">
          <div class="staffCalRow head">
            <span class="staffCalName"></span>
            <div class="staffCalCells" style="--staff-days:${daysInMonth}">${dayHead}</div>
          </div>
          ${rows || `<p class="emptyText">Sin personas registradas. Regístralas en Solicitudes → Personas registradas.</p>`}
        </div>
      </section>`;
  }

  // ── Lista + ficha por persona ──────────────────────────────────────────────
  function renderPeopleList(people) {
    const selected = people.find((p) => p.id === state.staffSelectedId) || null;
    const rows = people.map((person) => {
      const vd = person.vacationDays || {};
      const balance = vd.allocated == null
        ? `<span class="emptyText">sin días asignados</span>`
        : `${vd.allocated - vd.used} de ${vd.allocated} días ${vd.year}`;
      const isSel = selected && selected.id === person.id;
      // ACORDEÓN: la ficha se abre JUSTO debajo de la fila seleccionada — con
      // listados grandes, abrirla al final del panel dejaba "Registrar ausencia"
      // lejísimos de donde se hizo clic (feedback del usuario 2026-07-08).
      return `
        <button type="button" class="staffPersonRow ${isSel ? "selected" : ""}" data-staff-person="${person.id}" data-staff-name="${escapeAttribute(normalizeStaff(`${person.fullName} ${person.area || ""}`))}">
          <strong>${escapeHtml(person.fullName)}</strong>
          ${person.area ? `<span class="staffPersonArea">${escapeHtml(person.area)}</span>` : ""}
          <span class="staffPersonBalance">${balance}</span>
          <span class="projChevron">${isSel ? "▾" : "›"}</span>
        </button>
        ${isSel ? renderPersonDetail(person) : ""}`;
    }).join("");
    return `
      <section class="panel staffPanel">
        <div class="blockHeader"><strong>Personas y saldo de vacaciones</strong><span>${people.length}</span></div>
        <div class="staffPeopleList">${rows || `<p class="emptyText">Sin personas registradas.</p>`}</div>
        <p class="emptyText" data-staff-noresults hidden>Ninguna persona coincide con la búsqueda.</p>
      </section>`;
  }

  function renderPersonDetail(person) {
    const admin = isAdmin();
    const vd = person.vacationDays || {};
    const balance = vd.allocated == null
      ? "sin cuota asignada"
      : `${vd.allocated - vd.used} restantes (${vd.used} usados de ${vd.allocated})`;
    const history = person.absences.map((a) => `
      <div class="staffAbsRow">
        <span class="staffCalCell ${typeClass(a.type)}"></span>
        <span class="staffAbsText"><strong>${typeLabel(a.type)}</strong> · ${dateLabel(a.startDate)} → ${dateLabel(a.endDate)}${a.notes ? ` · ${escapeHtml(a.notes)}` : ""}</span>
        ${admin ? renderDeleteIconButton("Eliminar ausencia", `data-staff-abs-delete="${person.id}:${a.id}"`) : ""}
      </div>`).join("");
    return `
      <div class="staffPersonDetail" data-staff-name="${escapeAttribute(normalizeStaff(`${person.fullName} ${person.area || ""}`))}">
        <div class="staffDetailHead">
          <strong>${escapeHtml(person.fullName)}</strong>
          <span class="staffBalance">Saldo vacaciones ${vd.year}: ${balance}</span>
        </div>
        ${person.staffNotes ? `<p class="staffPersonNote">📝 ${escapeHtml(person.staffNotes)}</p>` : ""}
        ${admin ? `
        <div class="staffDetailActions">
          <button class="primaryButton compact" type="button" data-staff-abs-toggle>${state.staffFormOpen ? "Cancelar" : "+ Registrar ausencia"}</button>
          <button class="staffQuotaBtn" type="button" data-staff-quota-toggle title="Días de vacaciones al año — solo para calcular el saldo">Cuota anual: ${vd.allocated == null ? "sin asignar" : `${vd.allocated} días`} ✎</button>
          <button class="staffQuotaBtn" type="button" data-staff-notes-toggle title="Nota de esta persona, visible solo en Personal">Nota ✎</button>
        </div>
        ${state.staffFormOpen ? `
        <form class="staffAbsForm" data-staff-abs-form="${person.id}">
          <label>Tipo
            <select name="type">${absenceTypes().map(([k, m]) => `<option value="${k}">${m.label}</option>`).join("")}</select>
          </label>
          <label>Desde<input name="startDate" type="date" required /></label>
          <label>Hasta<input name="endDate" type="date" required /></label>
          <label class="staffNotesField">Nota<input name="notes" type="text" maxlength="500" placeholder="Opcional" /></label>
          <button class="primaryButton compact" type="submit">Guardar ausencia</button>
        </form>` : ""}
        ${state.staffQuotaOpen ? `
        <form class="staffDaysForm" data-staff-days-form="${person.id}">
          <label>Días de vacaciones al año (${vd.year}) <em>— solo para calcular el saldo, no marca días fuera</em>
            <input name="days" type="number" min="0" max="60" value="${vd.allocated ?? ""}" placeholder="20" required />
          </label>
          <input type="hidden" name="year" value="${vd.year}" />
          <button class="tinyButton" type="submit">Guardar cuota</button>
        </form>` : ""}
        ${state.staffNotesOpen ? `
        <form class="staffNotesForm" data-staff-notes-form="${person.id}">
          <label>Nota (solo visible en Personal)
            <textarea name="notes" rows="2" maxlength="1000" placeholder="p. ej. prefiere vacaciones en diciembre; teletrabaja los viernes">${escapeHtml(person.staffNotes || "")}</textarea>
          </label>
          <button class="tinyButton" type="submit">Guardar nota</button>
        </form>` : ""}` : `<p class="helperText">Solo los administradores registran o editan ausencias.</p>`}
        <div class="staffAbsList">
          <p class="staffAbsListTitle">Ausencias registradas</p>
          ${history || `<p class="emptyText">${admin ? "Aún no hay ausencias. Usa “+ Registrar ausencia” para marcar cuándo esta persona estará fuera; se pintará en el calendario." : "Sin ausencias registradas."}</p>`}
        </div>
      </div>`;
  }

  // ── Eventos ────────────────────────────────────────────────────────────────
  function bindEvents() {
    // Búsqueda: filtra por DOM sin re-render (conserva el foco y el cursor).
    const search = document.querySelector("#staffSearch");
    if (search) {
      search.addEventListener("input", () => {
        state.staffSearch = search.value;
        applyStaffFilter();
      });
    }
    for (const btn of document.querySelectorAll("[data-staff-month]")) {
      btn.addEventListener("click", () => {
        const delta = Number(btn.dataset.staffMonth);
        if (delta === 0) {
          state.staffMonth = "";
        } else {
          const [y, m] = currentMonth().split("-").map(Number);
          const d = new Date(y, m - 1 + delta, 1);
          state.staffMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        }
        paint();
      });
    }
    for (const btn of document.querySelectorAll("[data-staff-person]")) {
      btn.addEventListener("click", () => {
        const id = btn.dataset.staffPerson;
        const opening = state.staffSelectedId !== id;
        state.staffSelectedId = opening ? id : null;
        state.staffFormOpen = false;
        state.staffQuotaOpen = false;
        state.staffNotesOpen = false;
        paint();
        // "Peek" suave: asegura que la ficha recién abierta quede a la vista sin
        // robar el viewport (block:nearest no mueve nada si ya se ve).
        if (opening) {
          requestAnimationFrame(() =>
            document.querySelector(".staffPersonDetail")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
        }
      });
    }
    // Registrar ausencia (acción primaria) y Cuota anual (secundaria) son
    // mutuamente excluyentes: abrir una cierra la otra, para no amontonar formularios.
    document.querySelector("[data-staff-abs-toggle]")?.addEventListener("click", () => {
      state.staffFormOpen = !state.staffFormOpen;
      state.staffQuotaOpen = false;
      state.staffNotesOpen = false;
      paint();
      if (state.staffFormOpen) {
        requestAnimationFrame(() => document.querySelector("[data-staff-abs-form] select")?.focus());
      }
    });
    document.querySelector("[data-staff-quota-toggle]")?.addEventListener("click", () => {
      state.staffQuotaOpen = !state.staffQuotaOpen;
      state.staffFormOpen = false;
      state.staffNotesOpen = false;
      paint();
      if (state.staffQuotaOpen) {
        requestAnimationFrame(() => document.querySelector("[data-staff-days-form] input[name='days']")?.focus());
      }
    });
    document.querySelector("[data-staff-notes-toggle]")?.addEventListener("click", () => {
      state.staffNotesOpen = !state.staffNotesOpen;
      state.staffFormOpen = false;
      state.staffQuotaOpen = false;
      paint();
      if (state.staffNotesOpen) {
        requestAnimationFrame(() => document.querySelector("[data-staff-notes-form] textarea")?.focus());
      }
    });
    document.querySelector("[data-staff-abs-form]")?.addEventListener("submit", submitAbsence);
    document.querySelector("[data-staff-days-form]")?.addEventListener("submit", submitDays);
    document.querySelector("[data-staff-notes-form]")?.addEventListener("submit", submitNotes);
    for (const btn of document.querySelectorAll("[data-staff-abs-delete]")) {
      btn.addEventListener("click", () => deleteAbsence(btn.dataset.staffAbsDelete));
    }
  }

  async function submitAbsence(event) {
    event.preventDefault();
    const target = event.currentTarget;
    const personId = target.dataset.staffAbsForm;
    const form = new FormData(target);
    const body = {
      type: form.get("type"),
      startDate: form.get("startDate"),
      endDate: form.get("endDate"),
      notes: (form.get("notes") || "").toString().trim(),
    };
    if (!body.startDate || !body.endDate) return;
    const button = target.querySelector("button[type='submit']");
    button.disabled = true;
    button.textContent = "Guardando…";
    try {
      const payload = await apiRequest(`api/staff/people/${personId}/absences`, {
        method: "POST", body: JSON.stringify(body)
      });
      mergeAbsence(personId, payload.data);
      state.staffFormOpen = false;
      paint();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
      button.textContent = "Guardar";
    }
  }

  async function submitDays(event) {
    event.preventDefault();
    const target = event.currentTarget;
    const personId = target.dataset.staffDaysForm;
    const form = new FormData(target);
    const button = target.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      await apiRequest(`api/staff/people/${personId}/vacation-days`, {
        method: "PATCH",
        body: JSON.stringify({ year: form.get("year"), days: Number(form.get("days")) })
      });
      const person = findPerson(personId);
      if (person) person.vacationDays.allocated = Number(form.get("days"));
      state.staffQuotaOpen = false;
      paint();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  }

  async function submitNotes(event) {
    event.preventDefault();
    const target = event.currentTarget;
    const personId = target.dataset.staffNotesForm;
    const notes = (new FormData(target).get("notes") || "").toString().trim();
    const button = target.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      await apiRequest(`api/staff/people/${personId}/notes`, {
        method: "PATCH", body: JSON.stringify({ notes })
      });
      const person = findPerson(personId);
      if (person) person.staffNotes = notes;
      state.staffNotesOpen = false;
      paint();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  }

  async function deleteAbsence(ref) {
    const [personId, absenceId] = (ref || "").split(":");
    if (!personId || !absenceId) return;
    if (!window.confirm("¿Eliminar esta ausencia? No se puede deshacer.")) return;
    try {
      await apiRequest(`api/staff/people/${personId}/absences/${absenceId}`, { method: "DELETE" });
      const person = findPerson(personId);
      if (person) {
        person.absences = person.absences.filter((a) => a.id !== absenceId);
        recomputeUsed(person);
      }
      paint();
    } catch (error) {
      alert(error.message);
    }
  }

  function findPerson(personId) {
    return (state.staffData?.people || []).find((p) => p.id === personId) || null;
  }

  function mergeAbsence(personId, absence) {
    const person = findPerson(personId);
    if (!person) return;
    person.absences = [absence, ...person.absences].sort((a, b) => b.startDate.localeCompare(a.startDate));
    recomputeUsed(person);
  }

  // Reflejo local del cálculo del backend (días HÁBILES L-V de vacaciones del
  // año en curso) — evita recargar todo tras cada cambio (merge local estándar).
  function recomputeUsed(person) {
    const year = person.vacationDays?.year;
    if (!year) return;
    let used = 0;
    for (const a of person.absences) {
      if (a.type !== "vacation") continue;
      const start = new Date(`${a.startDate}T00:00:00`);
      const end = new Date(`${a.endDate}T00:00:00`);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (String(d.getFullYear()) === year && d.getDay() >= 1 && d.getDay() <= 5) used++;
      }
    }
    person.vacationDays.used = used;
  }

  return { render };
}
