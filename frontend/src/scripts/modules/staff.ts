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

  // Días HÁBILES de un rango (L-V, excluyendo asuetos completos) — la misma
  // medida que descuenta del saldo: el conteo por registro usa esta cifra.
  function businessDays(startIso, endIso) {
    const fullHols = new Set((state.staffData?.holidays || []).filter((h) => !h.half).map((h) => h.date));
    let count = 0;
    const end = new Date(`${endIso}T00:00:00`);
    for (let d = new Date(`${startIso}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (d.getDay() >= 1 && d.getDay() <= 5 && !fullHols.has(iso)) count++;
    }
    return count;
  }

  function holidayMap() {
    return new Map((state.staffData?.holidays || []).map((h) => [h.date, h]));
  }

  function isAdmin() {
    return (state.profile?.user?.roles || []).includes("admin");
  }
  function todayIso() {
    // "Hoy" = el día de GUATEMALA fijo (hora del negocio), no el del SO del
    // usuario — en-CA da AAAA-MM-DD directo (criterio único, ver docs/18).
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Guatemala" });
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
    const hols = holidayMap();

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
        const holiday = hols.get(iso);
        const weekday = new Date(`${iso}T00:00:00`).getDay();
        const weekend = weekday === 0 || weekday === 6;
        const title = absence
          ? `${escapeAttribute(person.fullName)} · ${typeLabel(absence.type)} ${absence.startDate} → ${absence.endDate}`
          : (holiday ? `${escapeAttribute(holiday.name)}${holiday.half ? " (medio día)" : ""}` : "");
        const cls = absence ? typeClass(absence.type) : (holiday ? "holiday" : "");
        return `<span class="staffCalCell ${weekend ? "weekend" : ""} ${cls}" ${title ? `title="${title}"` : ""}></span>`;
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
            ${hols.size ? `<span class="staffLegendItem"><span class="staffCalCell holiday"></span>Asueto</span>` : ""}
          </div>
          ${isAdmin() ? `<button class="tinyButton ghost" type="button" data-staff-holidays-toggle>${state.staffHolidaysOpen ? "Cerrar asuetos" : "Asuetos ✎"}</button>` : ""}
        </div>
        ${state.staffHolidaysOpen && isAdmin() ? renderHolidaysPanel() : ""}
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

  // ── Asuetos (admin): catálogo + extracción desde imagen con confirmación ──
  function renderHolidaysPanel() {
    const holidays = state.staffData?.holidays || [];
    const draft = state.staffHolidayDraft;
    const rows = holidays.map((h) => `
      <div class="staffAbsRow">
        <span class="staffCalCell holiday"></span>
        <span class="staffAbsText"><strong>${escapeHtml(dateLabel(h.date))}</strong> · ${escapeHtml(h.name)}${h.half ? " · medio día" : ""}${h.notes ? ` · <em>${escapeHtml(h.notes)}</em>` : ""}</span>
        ${renderDeleteIconButton("Eliminar asueto", `data-staff-holiday-delete="${h.date}"`)}
      </div>`).join("");
    const draftRows = (draft || []).map((d, i) => `
      <div class="staffDraftRow">
        <input type="checkbox" data-draft-include="${i}" ${d.include ? "checked" : ""} title="Incluir" />
        <input type="date" value="${escapeAttribute(d.date)}" data-draft-date="${i}" />
        <input type="text" value="${escapeAttribute(d.name)}" data-draft-name="${i}" maxlength="120" />
        <label class="staffDraftHalf"><input type="checkbox" data-draft-half="${i}" ${d.half ? "checked" : ""} />medio día</label>
        ${d.notes ? `<span class="staffDraftNote" title="${escapeAttribute(d.notes)}">⚠ ${escapeHtml(d.notes)}</span>` : ""}
      </div>`).join("");
    return `
      <div class="staffHolidaysPanel">
        <div class="staffHolidaysHead">
          <strong>Asuetos autorizados</strong>
          <label class="tinyButton attachFileBtn">Subir asuetos (imagen)
            <input type="file" id="staffHolidayFile" accept="image/*" hidden />
          </label>
        </div>
        ${state.staffExtracting ? `<p class="attachStatus" role="status">Leyendo la imagen y extrayendo fechas…</p>` : ""}
        ${draft ? `
        <div class="staffDraftBox">
          <p class="staffDraftTitle">Extraje ${draft.length} fecha(s) — ¿son correctas? Revisa, edita o desmarca antes de guardar:</p>
          ${draftRows}
          <div class="staffDraftActions">
            <button class="primaryButton compact" type="button" data-draft-save>Guardar asuetos</button>
            <button class="tinyButton ghost" type="button" data-draft-cancel>Descartar</button>
          </div>
        </div>` : ""}
        <form class="staffHolidayForm" id="staffHolidayAdd">
          <input name="date" type="date" required aria-label="Fecha del asueto" />
          <input name="name" type="text" placeholder="Nombre del asueto" required maxlength="120" />
          <label class="staffDraftHalf"><input name="half" type="checkbox" />medio día</label>
          <button class="tinyButton" type="submit">Agregar</button>
        </form>
        <div class="staffAbsList">${rows || `<p class="emptyText">Sin asuetos registrados. Súbelos desde la publicación oficial o agrégalos a mano.</p>`}</div>
        <p class="helperText">Los asuetos completos no descuentan del saldo de vacaciones; los medios días cuentan como día normal.</p>
      </div>`;
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
        <span class="staffAbsText"><strong>${typeLabel(a.type)}</strong> · ${dateLabel(a.startDate)} → ${dateLabel(a.endDate)} <span class="staffAbsDays">· ${(n => `${n} día${n === 1 ? "" : "s"} hábil${n === 1 ? "" : "es"}`)(businessDays(a.startDate, a.endDate))}</span>${a.notes ? ` · ${escapeHtml(a.notes)}` : ""}</span>
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
        requestAnimationFrame(() => {
          const form = document.querySelector("[data-staff-abs-form]");
          // Centrar el formulario: deja espacio DEBAJO para que el calendario
          // nativo (posición no controlable por CSS) no abra cortado al borde.
          form?.scrollIntoView({ block: "center", behavior: "smooth" });
          form?.querySelector("select")?.focus();
        });
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
    // Asuetos (admin): panel, alta manual, borrar, extraer de imagen y confirmar.
    document.querySelector("[data-staff-holidays-toggle]")?.addEventListener("click", () => {
      state.staffHolidaysOpen = !state.staffHolidaysOpen;
      paint();
    });
    document.querySelector("#staffHolidayAdd")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        await saveHolidays([{ date: form.get("date"), name: form.get("name"), half: form.get("half") === "on" }]);
      } catch (error) { alert(error.message); }
    });
    for (const btn of document.querySelectorAll("[data-staff-holiday-delete]")) {
      btn.addEventListener("click", async () => {
        const date = btn.dataset.staffHolidayDelete;
        if (!window.confirm(`¿Eliminar el asueto del ${date}?`)) return;
        try {
          await apiRequest(`api/staff/holidays/${date}`, { method: "DELETE" });
          state.staffData.holidays = (state.staffData.holidays || []).filter((h) => h.date !== date);
          paint();
        } catch (error) { alert(error.message); }
      });
    }
    document.querySelector("#staffHolidayFile")?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) extractHolidays(file);
    });
    document.querySelector("[data-draft-cancel]")?.addEventListener("click", () => {
      state.staffHolidayDraft = null;
      paint();
    });
    document.querySelector("[data-draft-save]")?.addEventListener("click", async () => {
      syncDraftFromDom();
      const included = (state.staffHolidayDraft || []).filter((d) => d.include);
      if (!included.length) { alert("No hay asuetos marcados para guardar."); return; }
      try {
        await saveHolidays(included);
        state.staffHolidayDraft = null;
        paint();
      } catch (error) { alert(error.message); }
    });
    const absForm = document.querySelector("[data-staff-abs-form]");
    absForm?.addEventListener("submit", submitAbsence);
    // "Desde" manda sobre "Hasta": al elegir inicio, el fin se precarga con esa
    // fecha (su calendario abre AHÍ, no en hoy) y no permite fechas anteriores.
    if (absForm) {
      const start = absForm.querySelector("input[name='startDate']");
      const end = absForm.querySelector("input[name='endDate']");
      start?.addEventListener("change", () => {
        if (!start.value || !end) return;
        end.min = start.value;
        if (!end.value || end.value < start.value) end.value = start.value;
      });
    }
    document.querySelector("[data-staff-days-form]")?.addEventListener("submit", submitDays);
    document.querySelector("[data-staff-notes-form]")?.addEventListener("submit", submitNotes);
    for (const btn of document.querySelectorAll("[data-staff-abs-delete]")) {
      btn.addEventListener("click", () => deleteAbsence(btn.dataset.staffAbsDelete));
    }
  }

  // Imagen → REDUCIR en el navegador → base64 → backend (Textract + GLM 5) →
  // borrador editable. La reducción es obligatoria: una foto original en base64
  // supera el límite de invocación de Lambda (6 MB) y API Gateway la rechaza
  // ANTES de llegar al backend (bug real 2026-07-09: "No fue posible completar
  // la acción" sin rastro en logs). A ~1600px el OCR lee perfecto y pesa <1 MB.
  function downscaleImage(file, maxSide = 1600) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen.")); };
      img.src = url;
    });
  }

  async function extractHolidays(file) {
    state.staffExtracting = true;
    state.staffHolidayDraft = null;
    paint();
    try {
      const image = await downscaleImage(file);
      if (image.length > 4.5 * 1024 * 1024) throw new Error("La imagen sigue siendo demasiado grande tras reducirla.");
      const payload = await apiRequest("api/staff/holidays/extract", {
        method: "POST", body: JSON.stringify({ image })
      });
      state.staffHolidayDraft = payload.data.draft;
    } catch (error) {
      alert(error.message);
    } finally {
      state.staffExtracting = false;
      paint();
    }
  }

  // El borrador se edita directo en el DOM (sin re-render por tecla): antes de
  // guardar se vuelca al estado.
  function syncDraftFromDom() {
    for (let i = 0; i < (state.staffHolidayDraft || []).length; i++) {
      const d = state.staffHolidayDraft[i];
      const inc = document.querySelector(`[data-draft-include="${i}"]`);
      const date = document.querySelector(`[data-draft-date="${i}"]`);
      const name = document.querySelector(`[data-draft-name="${i}"]`);
      const half = document.querySelector(`[data-draft-half="${i}"]`);
      if (inc) d.include = inc.checked;
      if (date?.value) d.date = date.value;
      if (name?.value.trim()) d.name = name.value.trim();
      if (half) d.half = half.checked;
    }
  }

  async function saveHolidays(list) {
    const payload = await apiRequest("api/staff/holidays", {
      method: "POST", body: JSON.stringify({ holidays: list })
    });
    // Merge por fecha: lo guardado reemplaza/añade sobre el catálogo local.
    const byDate = new Map((state.staffData.holidays || []).map((h) => [h.date, h]));
    for (const h of payload.data.holidays) byDate.set(h.date, h);
    state.staffData.holidays = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    paint();
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
      const fullHols = new Set((state.staffData?.holidays || []).filter((h) => !h.half).map((h) => h.date));
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (String(d.getFullYear()) === year && d.getDay() >= 1 && d.getDay() <= 5 && !fullHols.has(iso)) used++;
      }
    }
    person.vacationDays.used = used;
  }

  return { render };
}
