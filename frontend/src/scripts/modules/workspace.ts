// @ts-nocheck
// Módulo Proyectos y tareas (workspace). Inyección de dependencias desde el shell.
export function createWorkspaceModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, renderDeleteIconButton, priorityLabel } = ctx;

  // Columnas de la tabla de solicitudes: definición única (orden, etiqueta, clave
  // de orden, ancho por defecto). "Solicitud" es el identificador → siempre visible.
  const PROJECT_COLUMNS = [
    { key: "name", label: "Solicitud", always: true, width: 240 },
    { key: "type", label: "Tipo", width: 90 },
    { key: "area", label: "Área solicitante", width: 140 },
    { key: "targetArea", label: "Grupo de trabajo", width: 160, defaultHidden: true },
    { key: "status", label: "Estado", width: 120 },
    { key: "owner", label: "Responsable", width: 150 },
    { key: "tasks", label: "Tareas", num: true, width: 80 },
    { key: "activity", label: "Última actividad (seguimiento)", width: 300 },
  ];
  const PROJECT_TABLE_LS = "gp.projectTable.v1"; // columnas visibles + anchos (por navegador)
  let columnsCloser = null; // handler de cierre del menú "Columnas" al hacer clic fuera
  let filtersCloser = null; // handler de cierre del popover "Filtros" al hacer clic fuera

  function loadTablePrefs() {
    if (state._projectTablePrefsLoaded) return;
    state._projectTablePrefsLoaded = true;
    try {
      const saved = JSON.parse(localStorage.getItem(PROJECT_TABLE_LS) || "{}");
      state.projectColumns = saved.columns || {};
      state.projectColWidths = saved.widths || {};
      state.projectColOrder = Array.isArray(saved.order) ? saved.order : null;
    } catch {
      state.projectColumns = {};
      state.projectColWidths = {};
      state.projectColOrder = null;
    }
  }
  function saveTablePrefs() {
    try {
      localStorage.setItem(PROJECT_TABLE_LS, JSON.stringify({
        columns: state.projectColumns || {}, widths: state.projectColWidths || {},
        order: state.projectColOrder || null,
      }));
    } catch { /* localStorage no disponible: se pierde solo la persistencia */ }
  }
  function isColVisible(key) {
    const col = PROJECT_COLUMNS.find((c) => c.key === key);
    if (col?.always) return true;
    const v = state.projectColumns?.[key];
    return v === undefined ? !col?.defaultHidden : !!v; // por defecto visible salvo defaultHidden
  }
  function colWidth(key) {
    const col = PROJECT_COLUMNS.find((c) => c.key === key);
    return state.projectColWidths?.[key] || col?.width || 120;
  }
  // Columnas en el ORDEN preferido del usuario (persistido por navegador, como
  // visibilidad y anchos). "Solicitud" (name) es el identificador del maestro-
  // detalle: SIEMPRE va primera, no se reordena. Claves desconocidas en la
  // preferencia guardada se ignoran; columnas nuevas del código caen al final.
  function orderedColumns() {
    const order = state.projectColOrder;
    if (!order || !order.length) return PROJECT_COLUMNS;
    const rank = new Map(order.map((key, i) => [key, i]));
    return [...PROJECT_COLUMNS].sort((a, b) => {
      if (a.key === "name") return -1;
      if (b.key === "name") return 1;
      const ra = rank.has(a.key) ? rank.get(a.key) : 900 + PROJECT_COLUMNS.indexOf(a);
      const rb = rank.has(b.key) ? rank.get(b.key) : 900 + PROJECT_COLUMNS.indexOf(b);
      return ra - rb;
    });
  }
  function visibleColumns() {
    return orderedColumns().filter((c) => isColVisible(c.key));
  }
  // Mueve una columna un paso arriba/abajo dentro del orden actual y persiste.
  function moveColumn(key, dir) {
    const keys = orderedColumns().map((c) => c.key).filter((k) => k !== "name");
    const idx = keys.indexOf(key);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= keys.length) return;
    [keys[idx], keys[to]] = [keys[to], keys[idx]];
    state.projectColOrder = keys;
    saveTablePrefs();
  }

      async function renderWorkspace() {
        elements.statusPanel.hidden = true;
        elements.contentPanel.hidden = false;
        elements.viewTitle.textContent = "Solicitudes";
        elements.contentPanel.className = "workspaceLayout";

        if (!state.workspace) {
          elements.contentPanel.innerHTML = `<section class="panel"><h2>Cargando espacio de trabajo</h2><p>Preparando personas, solicitudes y tareas.</p></section>`;
          try {
            await loadWorkspace();
          } catch (error) {
            elements.contentPanel.innerHTML = `
              <section class="panel">
                <h2>No fue posible cargar las solicitudes</h2>
                <p>${escapeHtml(error.message || "Intenta nuevamente en unos minutos.")}</p>
              </section>
            `;
            return;
          }
        }

        const workspace = state.workspace;
        if (!workspace) {
          return;
        }
        loadTablePrefs();

        const peopleById = Object.fromEntries(workspace.people.map((person) => [person.id, person]));
        const visibleProjects = getVisibleProjects(workspace.projects, peopleById);
        const fallbackProject = visibleProjects[0] || null;

        if (state.activeProjectId && !visibleProjects.some((project) => project.id === state.activeProjectId)) {
          state.activeProjectId = fallbackProject?.id || null;
          state.selectedDetail = null;
        }

        if (!state.activeProjectId && fallbackProject) {
          state.activeProjectId = fallbackProject.id;
        }

        const activeProject = visibleProjects.find((project) => project.id === state.activeProjectId) || fallbackProject;
        const projectCountText = `${visibleProjects.length} de ${workspace.projects.length} solicitudes`;
        const personCreatedNotice = state.saveNotice?.target === "person-create" ? state.saveNotice.message : "";
        const visiblePeople = getVisiblePeople(workspace.people);
        const personDirectory = renderPeopleDirectory(visiblePeople);
        const peopleCountText = state.personSearch.trim()
          ? `${visiblePeople.length} de ${workspace.people.length}`
          : String(workspace.people.length);
        const selectedPersonDetail = renderSelectedPersonDetail();
        // Personas se auto-expande si hay algo en curso ahí (registro o edición).
        const peopleOpen = state.peopleSectionOpen || !!selectedPersonDetail || state.showPersonForm || !!state.personSearch.trim();

        // Dos vistas: "Gestión" (trabajar la lista: tabla, detalle, tareas) y
        // "Tablero de avance" (reportar/presentar: barras, qué falta, cuándo).
        // Comparten la MISMA barra de filtros — filtras en una, presentas en otra.
        const isBoard = (state.workspaceView || "manage") === "board";
        const viewToggle = `
          <div class="searchScope segmented wsViewToggle" role="group" aria-label="Vista de solicitudes">
            <button type="button" class="scopeSeg ${!isBoard ? "active" : ""}" data-ws-view="manage">Gestión</button>
            <button type="button" class="scopeSeg ${isBoard ? "active" : ""}" data-ws-view="board">Tablero de avance</button>
          </div>`;

        elements.contentPanel.innerHTML = `
          <section class="projectOverview">
            <section class="panel workspaceHero">
              <div class="workspaceHeroTop">
                <div class="workspaceHeroText">
                  <p class="eyebrow">Vista operativa</p>
                  <h2>Solicitudes</h2>
                  <p>${isBoard ? "Avance por solicitud, listo para presentar. Usa los filtros para acotar lo que se muestra." : "Elige una solicitud de la lista para ver sus personas, tareas y seguimiento."}</p>
                </div>
                ${viewToggle}
              </div>
              ${isBoard ? "" : `
              <form id="projectQuickForm" class="projectCreateForm">
                <input name="name" type="text" placeholder="Nueva solicitud" required />
                <select name="requestType" aria-label="Tipo de solicitud">
                  <option value="project">Proyecto</option>
                  <option value="report">Reporte</option>
                </select>
                <button class="primaryButton" type="submit">Nuevo</button>
              </form>`}
              <div class="workspaceControls">
                <input id="projectSearch" class="searchInput" type="search" placeholder="Buscar por nombre, descripción, persona…" value="${escapeAttribute(state.projectSearch)}" />
                <div class="searchScopeGroup">
                  <span class="searchScopeLabel">Buscar en:</span>
                  <div class="searchScope segmented" role="group" aria-label="Buscar en">
                    ${renderProjectSearchScopeButton("all", "Todo")}
                    ${renderProjectSearchScopeButton("projects", "Solicitudes")}
                    ${renderProjectSearchScopeButton("tasks", "Tareas")}
                  </div>
                </div>
              </div>
            </section>

            ${isBoard ? `
            <section class="panel projectTablePanel">
              <div class="projectTableHead">
                <div class="projectFilters" role="group" aria-label="Filtrar solicitudes por estado">
                  ${renderProjectStatusFilters()}
                </div>
                <div class="projectFilterBar">
                  ${renderFiltersControl()}
                  ${renderActiveFilterChips()}
                  ${anyProjectFilterActive() ? `<button class="tinyButton ghost" type="button" id="clearProjectFilters">Limpiar</button>` : ""}
                  <span class="countPill">${projectCountText}</span>
                </div>
              </div>
              ${renderProgressBoard(visibleProjects, peopleById)}
            </section>` : `
            ${workspace.projects.length === 0 ? `
            <section class="panel projectsEmptyCta">
              <h3>Aún no hay solicitudes</h3>
              <p>Crea la primera para empezar a organizar tareas, personas y seguimiento.</p>
              <button id="emptyCreateFocus" class="primaryButton" type="button">Crear la primera solicitud</button>
            </section>` : `
            <section class="panel projectTablePanel">
              <div class="projectTableHead">
                <div class="projectFilters" role="group" aria-label="Filtrar solicitudes por estado">
                  ${renderProjectStatusFilters()}
                </div>
                <div class="projectFilterBar">
                  ${renderFiltersControl()}
                  ${renderActiveFilterChips()}
                  ${anyProjectFilterActive() ? `<button class="tinyButton ghost" type="button" id="clearProjectFilters">Limpiar</button>` : ""}
                  <div class="projectColumnsControl">
                    <button class="tinyButton ghost" type="button" id="projectColumnsBtn" aria-haspopup="true" aria-expanded="${state.projectColumnsMenuOpen ? "true" : "false"}">Columnas ▾</button>
                    ${state.projectColumnsMenuOpen ? renderColumnsMenu() : ""}
                  </div>
                  <span class="countPill">${projectCountText}</span>
                </div>
              </div>
              <div class="projectTableWrap">
                ${renderProjectTable(visibleProjects, activeProject, peopleById)}
              </div>
            </section>

            ${activeProject ? renderProjectCard(activeProject, true, peopleById) : ""}`}`}

            ${isBoard ? "" : `
            <section class="panel peopleSection ${peopleOpen ? "open" : ""}">
              <div class="peopleSectionHead">
                <button id="peopleSectionToggle" class="peopleToggle" type="button" aria-expanded="${peopleOpen ? "true" : "false"}">
                  <span class="peopleChev">▸</span>
                  <strong>Personas registradas</strong>
                  <span class="countPill subtle">${peopleCountText}</span>
                </button>
                ${peopleOpen ? `<button id="togglePersonFormButton" class="secondaryButton compact" type="button">${state.showPersonForm ? "Cancelar" : "Registrar persona"}</button>` : ""}
              </div>
              ${peopleOpen ? `
              <div class="peopleBody" data-people-drop-zone>
                <form id="personQuickForm" class="personCreateForm" ${state.showPersonForm ? "" : "hidden"}>
                  <input name="firstName" type="text" placeholder="Nombre completo o proveedor" required />
                  <details class="optionalDetails">
                    <summary>Más datos</summary>
                    <input name="area" type="text" placeholder="Área" />
                    <textarea name="availabilityNotes" rows="2" placeholder="Vacaciones o disponibilidad"></textarea>
                    <textarea name="notes" rows="2" placeholder="Notas"></textarea>
                  </details>
                  <button class="primaryButton" type="submit">Registrar persona</button>
                </form>
                ${personCreatedNotice ? `<p class="saveFeedback compactFeedback" role="status">${escapeHtml(personCreatedNotice)}</p>` : ""}
                <input id="personSearch" class="searchInput personSearchInput" type="search" placeholder="Buscar persona" value="${escapeAttribute(state.personSearch)}" />
                <div class="peopleStrip">
                  ${personDirectory || renderPeopleEmptyState(workspace.people.length)}
                </div>
                <p class="peopleHint">Para agregar a alguien a una solicitud usa el selector "Agregar persona" de la solicitud; también puedes arrastrar su tarjeta hasta ella.</p>
                ${selectedPersonDetail ? `<section class="detailDrawerSlot personDetailSlot">${selectedPersonDetail}</section>` : ""}
              </div>` : ""}
            </section>`}
          </section>
        `;

        bindWorkspaceEvents();
      }

      async function loadWorkspace() {
        const payload = await apiRequest("api/workspace");
        state.workspace = payload.data;
      }

      function getVisibleProjects(projects, peopleById) {
        const query = normalizeSearch(state.projectSearch);
        const typeF = state.projectTypeFilter || "all";
        const areaF = state.projectAreaFilter || "all";
        const targetF = state.projectTargetAreaFilter || "all";
        const ownerF = state.projectOwnerFilter || "all";
        const involvesF = state.projectInvolvesFilter || "all";
        return projects.filter((project) => {
          if (state.projectStatusFilter === "none" && project.status) {
            return false;
          }
          if (state.projectStatusFilter !== "all" && state.projectStatusFilter !== "none" && project.status !== state.projectStatusFilter) {
            return false;
          }
          if (typeF !== "all" && (typeF === "__none__" ? !!project.requestType : (project.requestType || "") !== typeF)) {
            return false;
          }
          if (areaF !== "all" && (areaF === "__none__" ? !!project.requestingAreaId : (project.requestingAreaId || "") !== areaF)) {
            return false;
          }
          if (targetF !== "all" && (targetF === "__none__" ? !!project.targetAreaId : (project.targetAreaId || "") !== targetF)) {
            return false;
          }
          if (ownerF !== "all" && (ownerF === "__none__" ? !!project.ownerPersonId : (project.ownerPersonId || "") !== ownerF)) {
            return false;
          }
          // "Involucra a": la persona es el responsable O una persona relacionada
          // (miembro). Para rastrear a un proveedor por todas sus solicitudes.
          if (involvesF !== "all") {
            const isOwner = project.ownerPersonId === involvesF;
            const isMember = project.members.some((member) => member.personId === involvesF);
            if (!isOwner && !isMember) {
              return false;
            }
          }
          const tokens = searchTokens(state.projectSearch);
          if (!tokens.length) {
            return true;
          }
          // Alcance de una sola opción: "all" busca en ambos; "projects"/"tasks" acota.
          const scope = state.projectSearchScope || "all";
          const inProjects = (scope === "all" || scope === "projects")
            && matchesAllTokens(projectSearchText(project, peopleById), tokens);
          const inTasks = (scope === "all" || scope === "tasks")
            && project.tasks.some((task) => matchesAllTokens(taskSearchText(task, peopleById), tokens));
          return inProjects || inTasks;
        });
      }

      // Búsqueda por palabras (AND): TODAS las palabras deben aparecer → escribir más
      // acota en vez de ampliar, y "aqua licencia" encuentra "Licenciamiento Aqua".
      function searchTokens(query) {
        return normalizeSearch(query).split(/\s+/).filter(Boolean);
      }
      function matchesAllTokens(haystack, tokens) {
        return tokens.every((token) => haystack.includes(token));
      }

      // Campos buscables de una solicitud: nombre + descripción + área + responsable
      // + miembros. Lo estructurado (estado, tipo, prioridad) se acota con los filtros.
      function projectSearchText(project, peopleById) {
        const owner = peopleById[project.ownerPersonId]?.fullName || "";
        const members = project.members
          .map((member) => peopleById[member.personId]?.fullName || "")
          .join(" ");
        const area = areaName(project.requestingAreaId) || "";
        return normalizeSearch(`${project.name} ${project.description || ""} ${area} ${owner} ${members}`);
      }

      // Campos buscables de una tarea: título + notas + responsable (sin etiquetas de
      // prioridad/estado ni la clave cruda — esas generaban coincidencias fantasma).
      function taskSearchText(task, peopleById) {
        const assignee = peopleById[task.assigneePersonId]?.fullName || "";
        return normalizeSearch(`${task.title} ${task.notes || ""} ${assignee}`);
      }

      // Normalización: minúsculas, sin espacios sobrantes y SIN acentos (así
      // "analitica" encuentra "Analítica"), igual que la deduplicación del backend.
      function normalizeSearch(value) {
        return String(value || "")
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .trim().toLowerCase();
      }

      function taskStatusLabel(statusKey) {
        return state.workspace?.taskStatuses.find((status) => status.key === statusKey)?.label || "";
      }

      function renderProjectStatusFilters() {
        const options = [
          ["all", "Todos"],
          ["none", "Sin estado"],
          ...projectStatusList().map((s) => [s.id, s.label])
        ];
        return options
          .map(([status, label]) => `
            <button
              class="filterChip ${state.projectStatusFilter === status ? "active" : ""}"
              type="button"
              data-project-status-filter="${status}"
              aria-pressed="${state.projectStatusFilter === status ? "true" : "false"}"
            >${label}</button>
          `)
          .join("");
      }

      // Filtros por dimensión (dropdowns): Tipo, Área, Responsable. Las opciones
      // salen de los valores presentes en TODAS las solicitudes (no del subconjunto
      // ya filtrado), para que la selección actual siempre sea válida.
      function renderProjectDimensionFilters() {
        const projects = state.workspace?.projects || [];
        const peopleById = Object.fromEntries((state.workspace?.people || []).map((p) => [p.id, p]));

        const typeV = state.projectTypeFilter || "all";
        const typeSel = `<label class="filterSelect">Tipo
          <select data-filter="type">
            <option value="all">Todos</option>
            <option value="project" ${typeV === "project" ? "selected" : ""}>Proyecto</option>
            <option value="report" ${typeV === "report" ? "selected" : ""}>Reporte</option>
            ${projects.some((p) => !p.requestType) ? `<option value="__none__" ${typeV === "__none__" ? "selected" : ""}>Sin tipo</option>` : ""}
          </select></label>`;

        const areaV = state.projectAreaFilter || "all";
        const areaIds = [...new Set(projects.map((p) => p.requestingAreaId).filter(Boolean))]
          .sort((a, b) => (areaName(a) || "").localeCompare(areaName(b) || "", "es"));
        const areaSel = `<label class="filterSelect">Área solicitante
          <select data-filter="area">
            <option value="all">Todas</option>
            ${areaIds.map((id) => `<option value="${id}" ${areaV === id ? "selected" : ""}>${escapeHtml(areaName(id) || id)}</option>`).join("")}
            ${projects.some((p) => !p.requestingAreaId) ? `<option value="__none__" ${areaV === "__none__" ? "selected" : ""}>Sin área</option>` : ""}
          </select></label>`;

        // Grupo de trabajo (targetAreaId, antes "Área destino"): independiente de la
        // solicitante, ambos son AND → se puede pedir "solicita X y grupo Y" a la vez.
        const targetV = state.projectTargetAreaFilter || "all";
        const targetIds = [...new Set(projects.map((p) => p.targetAreaId).filter(Boolean))]
          .sort((a, b) => (areaName(a) || "").localeCompare(areaName(b) || "", "es"));
        const targetSel = `<label class="filterSelect">Grupo de trabajo
          <select data-filter="targetArea">
            <option value="all">Todos</option>
            ${targetIds.map((id) => `<option value="${id}" ${targetV === id ? "selected" : ""}>${escapeHtml(areaName(id) || id)}</option>`).join("")}
            ${projects.some((p) => !p.targetAreaId) ? `<option value="__none__" ${targetV === "__none__" ? "selected" : ""}>Sin grupo</option>` : ""}
          </select></label>`;

        const ownerV = state.projectOwnerFilter || "all";
        const ownerIds = [...new Set(projects.map((p) => p.ownerPersonId).filter(Boolean))]
          .sort((a, b) => (peopleById[a]?.fullName || "").localeCompare(peopleById[b]?.fullName || "", "es"));
        const ownerSel = `<label class="filterSelect">Responsable
          <select data-filter="owner">
            <option value="all">Todos</option>
            ${ownerIds.map((id) => `<option value="${id}" ${ownerV === id ? "selected" : ""}>${escapeHtml(peopleById[id]?.fullName || id)}</option>`).join("")}
            ${projects.some((p) => !p.ownerPersonId) ? `<option value="__none__" ${ownerV === "__none__" ? "selected" : ""}>Sin responsable</option>` : ""}
          </select></label>`;

        // "Involucra a": personas que son responsable O están relacionadas en alguna
        // solicitud (para rastrear a un proveedor por todas sus solicitudes).
        const involvesV = state.projectInvolvesFilter || "all";
        const involvedIds = new Set();
        for (const p of projects) {
          if (p.ownerPersonId) involvedIds.add(p.ownerPersonId);
          for (const m of (p.members || [])) involvedIds.add(m.personId);
        }
        const involvedList = [...involvedIds]
          .sort((a, b) => (peopleById[a]?.fullName || "").localeCompare(peopleById[b]?.fullName || "", "es"));
        const involvesSel = `<label class="filterSelect">Involucra a
          <select data-filter="involves">
            <option value="all">Cualquiera</option>
            ${involvedList.map((id) => `<option value="${id}" ${involvesV === id ? "selected" : ""}>${escapeHtml(peopleById[id]?.fullName || id)}</option>`).join("")}
          </select></label>`;

        return typeSel + areaSel + targetSel + ownerSel + involvesSel;
      }

      // Popover "Filtros ▾" con badge del número de dimensiones activas. Las
      // dimensiones ya no ocupan la barra (escalan sin saturarla); lo activo se ve
      // como chips removibles (renderActiveFilterChips) — patrón Linear/GitHub.
      function activeDimensionCount() {
        let n = 0;
        if ((state.projectTypeFilter || "all") !== "all") n++;
        if ((state.projectAreaFilter || "all") !== "all") n++;
        if ((state.projectTargetAreaFilter || "all") !== "all") n++;
        if ((state.projectOwnerFilter || "all") !== "all") n++;
        if ((state.projectInvolvesFilter || "all") !== "all") n++;
        return n;
      }
      function renderFiltersControl() {
        const n = activeDimensionCount();
        return `
          <div class="projectFilterControl">
            <button class="tinyButton ghost" type="button" id="projectFiltersBtn" aria-haspopup="true" aria-expanded="${state.projectFiltersMenuOpen ? "true" : "false"}">
              Filtros${n ? ` <span class="filterBadge">${n}</span>` : ""} ▾
            </button>
            ${state.projectFiltersMenuOpen ? `
            <div class="columnsMenu filtersMenu" role="menu">
              <p class="columnsMenuTitle">Filtrar por</p>
              ${renderProjectDimensionFilters()}
            </div>` : ""}
          </div>`;
      }
      // Chips de filtros activos: visibles y removibles individualmente (una × por
      // dimensión). Evita el filtro "invisible" que confunde el conteo.
      function renderActiveFilterChips() {
        const peopleById = Object.fromEntries((state.workspace?.people || []).map((p) => [p.id, p]));
        const chip = (dim, label, value) =>
          `<span class="activeFilterChip"><span class="activeFilterChipText"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span><button type="button" class="activeFilterChipRemove" data-chip-remove="${dim}" aria-label="Quitar filtro ${escapeHtml(label)}">×</button></span>`;
        const chips = [];
        const typeF = state.projectTypeFilter || "all";
        if (typeF !== "all") chips.push(chip("type", "Tipo", typeF === "__none__" ? "Sin tipo" : (REQUEST_TYPE_LABELS[typeF] || typeF)));
        const areaF = state.projectAreaFilter || "all";
        if (areaF !== "all") chips.push(chip("area", "Solicita", areaF === "__none__" ? "Sin área" : (areaName(areaF) || areaF)));
        const targetF = state.projectTargetAreaFilter || "all";
        if (targetF !== "all") chips.push(chip("targetArea", "Grupo", targetF === "__none__" ? "Sin grupo" : (areaName(targetF) || targetF)));
        const ownerF = state.projectOwnerFilter || "all";
        if (ownerF !== "all") chips.push(chip("owner", "Responsable", ownerF === "__none__" ? "Sin responsable" : (peopleById[ownerF]?.fullName || ownerF)));
        const involvesF = state.projectInvolvesFilter || "all";
        if (involvesF !== "all") chips.push(chip("involves", "Involucra", peopleById[involvesF]?.fullName || involvesF));
        return chips.join("");
      }

      function anyProjectFilterActive() {
        return (state.projectStatusFilter && state.projectStatusFilter !== "all")
          || (state.projectTypeFilter && state.projectTypeFilter !== "all")
          || (state.projectAreaFilter && state.projectAreaFilter !== "all")
          || (state.projectTargetAreaFilter && state.projectTargetAreaFilter !== "all")
          || (state.projectOwnerFilter && state.projectOwnerFilter !== "all")
          || (state.projectInvolvesFilter && state.projectInvolvesFilter !== "all")
          || !!state.projectSearch;
      }

      // Menú "Columnas": mostrar/ocultar cada columna (Solicitud siempre fija).
      function renderColumnsMenu() {
        // Además de mostrar/ocultar, cada fila lleva ↑/↓ para ORDENAR las columnas
        // al gusto de cada usuario (persistido por navegador). "Solicitud" es el
        // identificador: siempre visible y siempre primera (sin flechas).
        const cols = orderedColumns();
        const movable = cols.filter((c) => c.key !== "name");
        return `
          <div class="columnsMenu" role="menu">
            <p class="columnsMenuTitle">Mostrar y ordenar columnas</p>
            ${cols.map((c) => {
              const mi = movable.findIndex((m) => m.key === c.key);
              const arrows = c.key === "name" ? "" : `
                <span class="colMoveBtns">
                  <button type="button" class="colMoveBtn" data-col-move="${c.key}:-1" ${mi <= 0 ? "disabled" : ""} title="Subir columna" aria-label="Subir ${escapeAttribute(c.label)}">↑</button>
                  <button type="button" class="colMoveBtn" data-col-move="${c.key}:1" ${mi >= movable.length - 1 ? "disabled" : ""} title="Bajar columna" aria-label="Bajar ${escapeAttribute(c.label)}">↓</button>
                </span>`;
              return `
              <div class="columnsMenuRow">
                <label class="columnsMenuItem ${c.always ? "disabled" : ""}">
                  <input type="checkbox" data-col-toggle="${c.key}" ${isColVisible(c.key) ? "checked" : ""} ${c.always ? "disabled" : ""} />
                  ${escapeHtml(c.label)}
                </label>
                ${arrows}
              </div>`;
            }).join("")}
            <button class="tinyButton ghost" type="button" data-col-reset>Restablecer columnas</button>
          </div>`;
      }

      function renderProjectSearchScopeButton(scope, label) {
        // Control segmentado de UNA sola opción (no toggles): "Todo" busca en ambos.
        const isActive = (state.projectSearchScope || "all") === scope;
        return `
          <button
            class="scopeSeg ${isActive ? "active" : ""}"
            type="button"
            data-project-search-scope="${scope}"
            aria-pressed="${isActive ? "true" : "false"}"
          >${label}</button>
        `;
      }

      // Iniciales para el avatar del chip (primeras letras de las 2 primeras palabras).
      function personInitials(fullName) {
        const parts = (fullName || "").trim().split(/\s+/).slice(0, 2);
        return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?";
      }

      // Tabla maestro-detalle: una fila compacta por proyecto (escaneable de un
      // vistazo, patrón familiar tipo hoja de cálculo para usuarios sin experiencia
      // en herramientas de proyectos). Clic en la fila → detalle completo abajo.
      const REQUEST_TYPE_LABELS = { project: "Proyecto", report: "Reporte" };
      function requestTypeLabel(value) {
        return REQUEST_TYPE_LABELS[value] || "";
      }

      // Área solicitante: catálogo vivo (quién pide la solicitud). Las solicitudes
      // guardan el id; el nombre se resuelve aquí, así corregir un área mal escrita
      // corrige todas las solicitudes que la usan.
      const AREA_EXAMPLE = "p. ej. Gerencia de Canales Digitales";
      function areaName(areaId) {
        return state.workspace?.areas?.find((area) => area.id === areaId)?.name || "";
      }
      function areaOptions(selectedId) {
        const areas = state.workspace?.areas || [];
        const options = [`<option value="">Ninguna</option>`];
        if (!areas.length) {
          // Catálogo vacío: ejemplo transparente como referencia de qué va aquí.
          options.push(`<option value="" disabled>${escapeHtml(AREA_EXAMPLE)}</option>`);
        }
        for (const area of areas) {
          options.push(`<option value="${area.id}" ${area.id === selectedId ? "selected" : ""}>${escapeHtml(area.name)}</option>`);
        }
        options.push(`<option value="__new__">+ Agregar área nueva…</option>`);
        return options.join("");
      }

      // Campo de área reutilizable (Área solicitante y Grupo de trabajo comparten
      // el MISMO catálogo AREA): selector + lápiz (corregir) + papelera (eliminar, el
      // backend la protege si está en uso) + mini-formulario inline.
      function renderAreaField(name, label, selectedId) {
        return `
          <div class="areaField" data-area-field>
            <label>${escapeHtml(label)}
              <div class="fieldWithActions">
                <select name="${name}" data-area-select>
                  ${areaOptions(selectedId)}
                </select>
                ${renderEditIconButton("Corregir o eliminar el área", "data-area-fix hidden")}
              </div>
            </label>
            <div class="areaInlineForm" data-area-form data-mode="create" hidden>
              <input type="text" data-area-input placeholder="${escapeAttribute(AREA_EXAMPLE)}" aria-label="Nombre del área" />
              <div class="areaInlineActions">
                <button type="button" class="tinyButton" data-area-save>Guardar área</button>
                <button type="button" class="tinyButton ghost" data-area-cancel>Cancelar</button>
                <button type="button" class="tinyButton danger" data-area-del hidden>Eliminar área</button>
              </div>
            </div>
          </div>`;
      }

      // Orden por columna (clic en el encabezado: 1º asc, 2º desc). Sin orden
      // elegido se mantiene el del backend (última solicitud actualizada primero).
      function sortProjectsForTable(projects, peopleById) {
        const s = state.projectSort;
        if (!s) return projects;
        const val = (p) => {
          switch (s.key) {
            case "name": return p.name.toLowerCase();
            case "type": return requestTypeLabel(p.requestType).toLowerCase();
            case "area": return areaName(p.requestingAreaId).toLowerCase();
            case "targetArea": return areaName(p.targetAreaId).toLowerCase();
            case "status": return p.status ? projectStatusLabel(p.status).toLowerCase() : "";
            case "owner": return (peopleById[p.ownerPersonId]?.fullName || "").toLowerCase();
            case "tasks": return p.tasks.length;
            case "activity": return `${p.updates?.[0]?.date || ""}#${p.updates?.[0]?.createdAt || ""}`;
            default: return "";
          }
        };
        return [...projects].sort((a, b) => {
          const va = val(a), vb = val(b);
          return (va < vb ? -1 : va > vb ? 1 : 0) * s.dir;
        });
      }

      function projSortTh(key, label, extraClass) {
        const active = state.projectSort?.key === key;
        const arrow = active ? (state.projectSort.dir === 1 ? " ▲" : " ▼") : "";
        // Etiqueta = ordenar (clic); asa a la derecha = arrastrar para el ancho.
        return `<th class="sortableTh ${active ? "active" : ""} ${extraClass || ""}">
          <span class="thLabel" data-proj-sort="${key}" title="Ordenar por ${escapeAttribute(label)}">${escapeHtml(label)}${arrow}</span>
          <span class="colResize" data-col-resize="${key}" title="Arrastra para ajustar el ancho"></span>
        </th>`;
      }

      // Señales al seleccionar una fila SIN robar el viewport (anti scroll-hijacking):
      // - selección normal → "peek": desplaza lo mínimo para que el encabezado del
      //   detalle asome por abajo, manteniendo el listado a la vista;
      // - intención explícita (chevron ›) → viaje completo al detalle.
      // Siempre destella el borde del panel para dirigir la mirada.
      function revealProjectDetail(full = false) {
        const card = document.querySelector(".projectOverviewCard.active");
        if (!card) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const rect = card.getBoundingClientRect();
        const peek = 180; // px del detalle que deben verse para saber que existe
        if (full) {
          const headroom = 96;
          if (rect.top > window.innerHeight - 220 || rect.top < headroom) {
            const top = window.scrollY + rect.top - headroom;
            window.scrollTo({ top: Math.max(top, 0), behavior: reduce ? "auto" : "smooth" });
          }
        } else if (rect.top > window.innerHeight - peek) {
          // Solo el desplazamiento mínimo: el panel asoma, el listado sigue visible.
          const top = window.scrollY + rect.top - (window.innerHeight - peek);
          window.scrollTo({ top: Math.max(top, 0), behavior: reduce ? "auto" : "smooth" });
        }
        if (!reduce && card.animate) {
          card.animate(
            [
              { boxShadow: "0 0 0 0 rgba(15, 118, 110, 0)" },
              { boxShadow: "0 0 0 3px rgba(15, 118, 110, 0.45)", offset: 0.25 },
              { boxShadow: "0 0 0 0 rgba(15, 118, 110, 0)" },
            ],
            { duration: 900, easing: "ease-out" },
          );
        }
      }

      // Celda por columna (permite ocultar/mostrar y reordenar sin duplicar lógica).
      function renderProjectCell(key, project, peopleById) {
        switch (key) {
          case "name":
            return `<td class="projName">${escapeHtml(project.name)}</td>`;
          case "type":
            return `<td>${requestTypeLabel(project.requestType) || `<span class="emptyText">—</span>`}</td>`;
          case "area":
            return `<td>${areaName(project.requestingAreaId) ? escapeHtml(areaName(project.requestingAreaId)) : `<span class="emptyText">—</span>`}</td>`;
          case "targetArea":
            return `<td>${areaName(project.targetAreaId) ? escapeHtml(areaName(project.targetAreaId)) : `<span class="emptyText">—</span>`}</td>`;
          case "status":
            return `<td>${project.status ? `<span class="statusBadge ${projectStatusClass(project.status)}">${projectStatusLabel(project.status)}</span>` : `<span class="emptyText">—</span>`}</td>`;
          case "owner":
            return `<td>${escapeHtml(peopleById[project.ownerPersonId]?.fullName || "—")}</td>`;
          case "tasks": {
            const done = project.tasks.filter((t) => t.status === "done").length;
            return `<td class="num">${done}/${project.tasks.length}</td>`;
          }
          case "activity": {
            const upd = (project.updates || [])[0];
            if (!upd) return `<td class="projActivity"><span class="emptyText">Sin seguimiento aún</span></td>`;
            // Texto completo (sin recortar en JS): la columna recorta con elipsis y,
            // al ensancharla, se ve más; el tooltip muestra todo.
            const full = `${updateDateLabel(upd.date)} · ${upd.text}`;
            return `<td class="projActivity" title="${escapeAttribute(full)}"><span class="projActivityDate">${escapeHtml(shortDateLabel(upd.date))}</span> · ${escapeHtml(upd.text)}</td>`;
          }
        }
        return `<td></td>`;
      }

      function renderProjectTable(projects, activeProject, peopleById) {
        if (!projects.length) {
          return `<p class="emptyText projectTableEmpty">No hay resultados con los filtros actuales.</p>`;
        }
        const cols = visibleColumns();
        const colgroup = `<colgroup>${cols.map((c) => `<col style="width:${colWidth(c.key)}px" />`).join("")}<col style="width:32px" /></colgroup>`;
        const head = cols.map((c) => projSortTh(c.key, c.label, c.num ? "num" : "")).join("");
        const rows = sortProjectsForTable(projects, peopleById).map((project) => {
          const selected = activeProject?.id === project.id;
          const cells = cols.map((c) => renderProjectCell(c.key, project, peopleById)).join("");
          return `
            <tr class="projectRow ${selected ? "selected" : ""}" data-project-row="${project.id}" data-project-id="${project.id}" title="Ver detalle de ${escapeAttribute(project.name)}">
              ${cells}
              <td class="projChevron" title="Ir al detalle">${selected ? "▾" : "›"}</td>
            </tr>`;
        }).join("");
        return `
          <table class="projectTable resizable">
            ${colgroup}
            <thead>
              <tr>${head}<th class="projChevronTh" aria-hidden="true"></th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`;
      }

      // % de avance de una solicitud: manda el MANUAL (project.progress, opinión
      // del responsable como en los informes ejecutivos); si no está definido y
      // hay tareas, se deriva de tareas completadas/total; si no, no hay dato.
      function projectProgress(project) {
        if (project.progress !== "" && project.progress !== undefined && project.progress !== null) {
          return { pct: project.progress, source: "manual" };
        }
        if (project.tasks.length) {
          const done = project.tasks.filter((t) => t.status === "done").length;
          return { pct: Math.round((100 * done) / project.tasks.length), source: "tareas" };
        }
        return { pct: null, source: "none" };
      }

      // Tablero de avance: informe ejecutivo para presentar. Estatus por estado
      // (del conjunto FILTRADO), barras 0-100% agrupadas por área solicitante,
      // y al clic el detalle "¿Qué falta? / ¿Cuándo?" (tareas pendientes + entrega).
      function renderProgressBoard(projects, peopleById) {
        if (!projects.length) {
          return `<p class="emptyText projectTableEmpty">No hay solicitudes con los filtros actuales.</p>`;
        }
        // Estatus (como el "Estatus GAD" de los informes): conteo por estado.
        const counts = [];
        counts.push({ label: "Total", n: projects.length, cls: "" });
        for (const s of projectStatusList()) {
          const n = projects.filter((p) => p.status === s.id).length;
          if (n) counts.push({ label: s.label, n, cls: `statusTone-${s.color}` });
        }
        const noStatus = projects.filter((p) => !p.status).length;
        if (noStatus) counts.push({ label: "Sin estado", n: noStatus, cls: "" });
        const countsHtml = `
          <div class="boardCounts">
            ${counts.map((c) => `
              <div class="boardCount">
                <span class="boardCountLabel ${c.cls}">${escapeHtml(c.label)}</span>
                <span class="boardCountN">${c.n}</span>
              </div>`).join("")}
          </div>`;

        // Agrupar por área solicitante (las sin área, al final).
        const groups = new Map();
        for (const p of projects) {
          const key = p.requestingAreaId || "";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(p);
        }
        const ordered = [...groups.entries()].sort((a, b) => {
          if (!a[0]) return 1;
          if (!b[0]) return -1;
          return (areaName(a[0]) || "").localeCompare(areaName(b[0]) || "", "es");
        });

        const groupsHtml = ordered.map(([areaId, items]) => `
          <div class="boardGroup">
            <p class="boardGroupTitle">${escapeHtml((areaName(areaId) || "Sin área").toUpperCase())}</p>
            ${items.map((p) => renderBoardRow(p, peopleById)).join("")}
          </div>`).join("");

        return countsHtml + groupsHtml + `
          <p class="boardHint">Clic en una solicitud para ver qué falta y cuándo. El % es el registrado en la solicitud; si no tiene, se calcula por tareas completadas.</p>`;
      }

      function renderBoardRow(project, peopleById) {
        const { pct, source } = projectProgress(project);
        const owner = peopleById[project.ownerPersonId]?.fullName || "—";
        const isOpen = state.boardExpanded === project.id;
        const done = pct === 100;
        const entrega = done
          ? `<span class="boardDone">Entregado</span>`
          : (project.dueDate ? `entrega ${escapeHtml(updateDateLabel(project.dueDate))}` : "sin fecha de entrega");
        const ticks = [10, 20, 30, 40, 50, 60, 70, 80, 90]
          .map((t) => `<i class="boardTick" style="left:${t}%"></i>`).join("");
        const bar = pct === null
          ? `<div class="boardBar empty" title="Sin % registrado y sin tareas">${ticks}</div>`
          : `<div class="boardBar" title="${pct}%${source === "tareas" ? " (según tareas)" : ""}"><div class="boardFill ${done ? "done" : ""}" style="width:${pct}%"></div>${ticks}</div>`;
        const pending = project.tasks.filter((t) => t.status !== "done");
        let detail = "";
        if (isOpen) {
          if (pending.length) {
            detail = `
              <div class="boardDetail">
                <div class="boardDetailHead"><span>Pendiente</span><span>¿Qué falta?</span><span>¿Cuándo?</span></div>
                ${pending.map((t) => `
                  <div class="boardDetailRow">
                    <span class="boardDetailName">${escapeHtml(t.title)}</span>
                    <span>${escapeHtml(t.notes || taskStatusLabel(t.status))}</span>
                    <span>${project.dueDate ? escapeHtml(updateDateLabel(project.dueDate)) : "—"}</span>
                  </div>`).join("")}
              </div>`;
          } else if (done) {
            detail = `<p class="boardDetailNote ok">Sin pendientes — entregado.</p>`;
          } else {
            detail = `<p class="boardDetailNote">Sin tareas pendientes registradas. Anota las tareas de la solicitud para detallar qué falta.</p>`;
          }
        }
        return `
          <div class="boardRow ${isOpen ? "open" : ""}" data-board-toggle="${project.id}">
            <div class="boardRowGrid">
              <div class="boardRowInfo">
                <span class="boardRowName">${escapeHtml(project.name)}</span>
                <span class="boardRowMeta">${escapeHtml(owner)} · ${entrega}</span>
              </div>
              ${bar}
              <span class="boardPct ${done ? "done" : ""}">${pct === null ? "—" : `${pct}%`}</span>
            </div>
            ${detail}
          </div>`;
      }

      function renderPersonCard(person) {
        const isSelected = state.selectedDetail?.type === "person" && state.selectedDetail.id === person.id;
        // Chip de una sola línea: avatar de iniciales + nombre con elipsis (el
        // completo va en el tooltip) + lápiz alineado — altura uniforme, sin
        // nombres partidos en varias líneas ni tarjetas cortadas a la mitad.
        return `
          <article class="personCard ${isSelected ? "selected" : ""}" draggable="true" data-person-id="${person.id}" data-person-select="${person.id}" title="${escapeAttribute(person.fullName)}">
            <span class="personAvatar" aria-hidden="true">${escapeHtml(personInitials(person.fullName))}</span>
            <strong class="personCardName">${escapeHtml(person.fullName)}</strong>
            ${renderEditIconButton("Editar persona", `data-detail-person="${person.id}"`)}
          </article>
        `;
      }

      function getVisiblePeople(people) {
        const query = normalizeSearch(state.personSearch);
        if (!query) {
          return people;
        }
        return people.filter((person) => normalizeSearch(`${person.fullName} ${person.area || ""} ${person.availabilityNotes || ""} ${person.notes || ""}`).includes(query));
      }

      function renderPeopleDirectory(people) {
        return people.map((person) => renderPersonCard(person)).join("");
      }

      function renderPeopleEmptyState(totalPeople) {
        if (totalPeople > 0 && state.personSearch.trim()) {
          return `<p class="emptyText">No hay personas que coincidan con la búsqueda.</p>`;
        }
        return `<p class="emptyText">Registra la primera persona para asignarla a solicitudes y tareas.</p>`;
      }

      function renderProjectCard(project, isActive, peopleById) {
        const memberChips = project.members
          .map((member) => {
            const person = peopleById[member.personId];
            if (!person) {
              return "";
            }
            return `
              <span
                class="memberChip"
                draggable="true"
                data-member-drag-project="${project.id}"
                data-member-drag-person="${member.personId}"
              >${escapeHtml(person.fullName)}<button
                type="button"
                class="memberChipRemove"
                data-member-remove-project="${project.id}"
                data-member-remove-person="${member.personId}"
                title="Quitar de la solicitud"
                aria-label="Quitar a ${escapeAttribute(person.fullName)} de la solicitud"
              >×</button></span>
            `;
          })
          .join("");
        const memberIds = new Set(project.members.map((member) => member.personId));
        const availablePeople = state.workspace.people.filter((person) => !memberIds.has(person.id));
        const isSelected = state.selectedDetail?.type === "project" && state.selectedDetail.id === project.id;
        const owner = peopleById[project.ownerPersonId] || null;
        const summary = renderTaskSummary(project);
        const boardOpen = state.expandedBoardProjectId === project.id;
        const taskFormOpen = state.showTaskForm && state.taskFormProjectId === project.id;
        const columns = boardOpen ? state.workspace.taskStatuses.map((status) => renderTaskColumn(status, project, peopleById)).join("") : "";
        const detailPanel = renderProjectInlineDetail(project, peopleById);
        const projectCreatedNotice = state.saveNotice?.target === `project-create:${project.id}` ? state.saveNotice.message : "";
        const taskCreatedNotice = state.saveNotice?.target === `task-create:${project.id}` ? state.saveNotice.message : "";
        const cardNotice = projectCreatedNotice || taskCreatedNotice;
        return `
          <article class="projectOverviewCard ${projectStatusClass(project.status)} ${isActive ? "active" : ""} ${isSelected ? "selected" : ""} ${detailPanel ? "hasInlineDetail" : ""}" data-project-id="${project.id}">
            <div class="projectCardMain">
              <div class="projectOverviewHeader">
                <div>
                  <p class="eyebrow">Detalle de la solicitud</p>
                  <h2>${escapeHtml(project.name)}</h2>
                  ${owner ? `<p>Responsable: <strong>${escapeHtml(owner.fullName)}</strong></p>` : ""}
                  ${areaName(project.requestingAreaId) ? `<p>Área solicitante: <strong>${escapeHtml(areaName(project.requestingAreaId))}</strong>${areaName(project.targetAreaId) ? ` · grupo de trabajo: <strong>${escapeHtml(areaName(project.targetAreaId))}</strong>` : ""}</p>` : (areaName(project.targetAreaId) ? `<p>Grupo de trabajo: <strong>${escapeHtml(areaName(project.targetAreaId))}</strong></p>` : "")}
                  ${(project.requestDate || project.dueDate) ? `<p class="projectDates">${project.requestDate ? `Solicitud: <strong>${escapeHtml(updateDateLabel(project.requestDate))}</strong>` : ""}${project.requestDate && project.dueDate ? " · " : ""}${project.dueDate ? `Entrega: <strong>${escapeHtml(updateDateLabel(project.dueDate))}</strong>` : ""}</p>` : ""}
                  ${project.description ? `<p class="projectOverviewDescription">${escapeHtml(project.description)}</p>` : ""}
                </div>
                <div class="projectHeaderRight">
                  ${project.status ? `<span class="statusBadge ${projectStatusClass(project.status)}">${projectStatusLabel(project.status)}</span>` : ""}
                  <div class="projectActions">
                    <button class="tinyButton" type="button" data-toggle-task-form="${project.id}">${taskFormOpen ? "Cancelar" : "Crear tarea"}</button>
                    <button class="tinyButton ghost" type="button" data-toggle-board="${project.id}">${boardOpen ? "Ocultar tablero" : "Ver tablero"}</button>
                    <button class="tinyButton ghost" type="button" data-detail-project="${project.id}">Editar solicitud</button>
                  </div>
                </div>
              </div>

              ${renderProjectAttachments(project)}

              <div class="projectOverviewGrid">
                <section class="projectPeopleBlock">
                  <div class="blockHeader">
                    <strong>Personas relacionadas</strong>
                    <span>${project.members.length}</span>
                  </div>
                  <div class="memberChipList spacious">
                    ${memberChips || `<span class="emptyText">Agrega personas a la solicitud.</span>`}
                  </div>
                  ${availablePeople.length ? `
                    <select class="projectMemberSelect inline" data-project-member="${project.id}" aria-label="Agregar persona al proyecto">
                      <option value="">Agregar persona</option>
                      ${availablePeople.map((person) => `<option value="${person.id}">${escapeHtml(person.fullName)}</option>`).join("")}
                    </select>
                  ` : `<p class="emptyText helperText">No hay personas disponibles para agregar.</p>`}
                </section>

                <section class="projectSummaryBlock">
                  <div class="blockHeader">
                    <strong>Tareas</strong>
                    <span>${project.tasks.length}</span>
                  </div>
                  <p>${summary}</p>
                </section>
              </div>

              ${renderProjectUpdates(project)}

              <form class="inlineForm projectTaskForm" data-task-quick-project="${project.id}" ${taskFormOpen ? "" : "hidden"}>
                <input name="title" type="text" placeholder="Nueva tarea" required />
                <button class="primaryButton" type="submit">Crear tarea</button>
              </form>

              ${cardNotice ? `<p class="saveFeedback compactFeedback" role="status">${escapeHtml(cardNotice)}</p>` : ""}

              ${boardOpen ? `<div class="kanbanBoard compactBoard">${columns}</div>` : ""}
            </div>
            ${detailPanel ? `<section class="detailDrawerSlot">${detailPanel}</section>` : ""}
          </article>
        `;
      }

      // Fecha de una entrada de seguimiento con día de semana ("vie 27 jun 2026").
      // OJO: new Date("AAAA-MM-DD") parsea como medianoche UTC y en Guatemala
      // (UTC-6) mostraría el día ANTERIOR — se parsea por partes (fecha local).
      function updateDateLabel(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
        if (!m) return iso || "";
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return d.toLocaleDateString("es-GT", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      }

      // Fecha CORTA para celdas de tabla ("6 jul"; agrega el año solo si es otro):
      // en la columna de Última actividad la fecha es metadato — no debe comerse
      // el espacio del texto del seguimiento (jerarquía visual, docs/06).
      function shortDateLabel(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
        if (!m) return iso || "";
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return d.toLocaleDateString("es-GT", sameYear
          ? { day: "numeric", month: "short" }
          : { day: "numeric", month: "short", year: "numeric" });
      }

      // Hora en que se registró la entrada (createdAt es UTC; se muestra en hora de
      // Guatemala). Discreta: solo para ubicar el momento dentro del día.
      function updateTimeLabel(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        return d.toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Guatemala" });
      }

      // Seguimiento (bitácora): qué se trabajó cada día. La entrada nueva toma la
      // fecha de HOY sola (la pone el backend); cada entrada es editable (texto y
      // fecha, por si se anotó mal) con el lápiz. Se muestran las 3 más recientes
      // y un "Ver todas (N)" para el resto.
      function renderUpdateRow(project, u, editing) {
        if (editing && editing.projectId === project.id && editing.updateId === u.id) {
          return `
            <form class="projectUpdateRow projectUpdateEditForm" data-update-edit-form="${project.id}" data-update-id="${u.id}">
              <input class="projectUpdateDateInput" name="date" type="date" value="${escapeAttribute(u.date)}" required aria-label="Fecha del seguimiento" />
              <input class="projectUpdateTextInput" name="text" type="text" value="${escapeAttribute(u.text)}" required aria-label="Texto del seguimiento" />
              <div class="projectUpdateEditActions">
                <button class="tinyButton" type="submit">Guardar</button>
                <button class="tinyButton ghost" type="button" data-update-cancel>Cancelar</button>
                <button class="tinyButton danger" type="button" data-update-delete="${project.id}" data-update-id="${u.id}">Eliminar</button>
              </div>
            </form>`;
        }
        // Meta discreta por entrada: hora (aún más tenue) · autor. La fecha ya no
        // va aquí: es el encabezado del día que agrupa estas entradas.
        const author = u.createdByName || u.createdBy || "";
        const time = updateTimeLabel(u.createdAt);
        const meta = [
          time ? `<span class="projectUpdateTime">${escapeHtml(time)}</span>` : "",
          author ? `<span class="projectUpdateAuthor" title="Registrado por ${escapeAttribute(author)}">${escapeHtml(author)}</span>` : ""
        ].filter(Boolean).join(" · ");
        // Adjuntos ligados a ESTA entrada (contexto) — SOLO vista: se agregan y se
        // relacionan desde la franja "Adjuntos" (único lugar de subida). Aquí se ven
        // como chips clicables para abrirlos en su contexto de la bitácora.
        const entryAtts = (project.attachments || []).filter((a) => a.updateId === u.id);
        const attachChips = entryAtts.map((a) => {
          const isQuery = a.kind === "query";
          const open = isQuery
            ? `data-attach-query-view="${project.id}:${a.id}"`
            : `data-attach-open="${project.id}:${a.id}"`;
          const icon = isQuery ? "{ }" : (isImageName(a.fileName) ? "🖼" : "📄");
          const name = isQuery ? (a.title || "Query") : (a.fileName || "archivo");
          return `<button type="button" class="attachChip attachChipOpen" ${open} title="Ver ${escapeAttribute(name)}"><span aria-hidden="true">${icon}</span> ${escapeHtml(name)}</button>`;
        }).join("");
        // Meta ARRIBA del texto (no en línea): el texto ocupa todo el ancho y no
        // lo empuja un nombre largo; todos los renglones arrancan alineados.
        return `
          <div class="projectUpdateRow">
            <div class="projectUpdateBody">
              ${meta ? `<span class="projectUpdateMeta">${meta}</span>` : ""}
              <span class="projectUpdateText">${escapeHtml(u.text)}</span>
              ${attachChips ? `<div class="attachInline">${attachChips}</div>` : ""}
            </div>
            ${renderEditIconButton("Editar seguimiento", `data-update-edit="${project.id}" data-update-id="${u.id}"`)}
          </div>`;
      }

      function renderProjectUpdates(project) {
        const updates = project.updates || [];
        const expanded = !!state.updatesExpanded[project.id];
        const visible = expanded ? updates : updates.slice(0, 3);
        const editing = state.updateEditing;
        // Agrupar por día (las entradas ya vienen ordenadas de la más reciente a la
        // más antigua): la fecha se muestra UNA vez como encabezado y debajo van
        // sus entradas — evita repetir "lun, 6 jul 2026" en cada renglón.
        const groups = [];
        for (const u of visible) {
          const last = groups[groups.length - 1];
          if (last && last.date === u.date) last.items.push(u);
          else groups.push({ date: u.date, items: [u] });
        }
        const rows = groups.map((g) => `
          <div class="projectUpdateDay">
            <div class="projectUpdateDayHeader">${escapeHtml(updateDateLabel(g.date))}</div>
            ${g.items.map((u) => renderUpdateRow(project, u, editing)).join("")}
          </div>`).join("");
        return `
          <section class="projectUpdatesBlock">
            <div class="blockHeader">
              <strong>Seguimiento</strong>
              <span>${updates.length}</span>
            </div>
            <form class="inlineForm projectUpdateForm" data-update-quick-project="${project.id}">
              <input name="text" type="text" placeholder="¿Qué se trabajó hoy? Se registra con la fecha de hoy" required maxlength="2000" />
              <button class="primaryButton" type="submit">Registrar</button>
            </form>
            <div class="projectUpdateList">
              ${rows || `<p class="emptyText">Sin registros aún. Anota lo trabajado para llevar la bitácora de la solicitud.</p>`}
            </div>
            ${updates.length > 3 ? `<button class="tinyButton ghost projectUpdateToggle" type="button" data-update-toggle="${project.id}">${expanded ? "Ver menos" : `Ver todas (${updates.length})`}</button>` : ""}
          </section>`;
      }

      // Tipos que acepta el <input type=file> (alineado con la whitelist del backend).
      const ATTACH_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.csv,.txt,.sql,.json,.log";
      const ATTACH_IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif"];
      function isImageName(name) {
        const ext = (name || "").split(".").pop().toLowerCase();
        return ATTACH_IMAGE_EXT.includes(ext);
      }
      // Franja "Adjuntos" (índice): vive en el encabezado del detalle, junta TODOS
      // los adjuntos de la solicitud (archivos + queries) con su etiqueta de origen.
      // Subir un adjunto "General" y crear queries se hace desde aquí; adjuntar CON
      // contexto se hace dentro de cada entrada de Seguimiento (renderUpdateRow).
      function renderProjectAttachments(project) {
        const atts = project.attachments || [];
        const queryOpen = state.attachQueryFor === project.id;
        const uploading = !!(state.attachUploading && state.attachUploading[project.id]);
        const error = state.attachError ? state.attachError[project.id] : "";
        return `
          <section class="attachBlock">
            <div class="blockHeader">
              <strong>Adjuntos</strong>
              <span>${atts.length}</span>
            </div>
            <div class="attachGrid">
              ${atts.map((a) => renderAttachmentItem(project, a)).join("")
                || `<span class="emptyText">Sin adjuntos. Agrega pantallazos, archivos o queries de la solicitud.</span>`}
            </div>
            ${(state.attachNoteFor || "").startsWith(`${project.id}:`) ? `
            <form class="inlineForm attachNoteForm" data-attach-note-form="${state.attachNoteFor}">
              <input name="text" type="text" placeholder="Nota (se registra como seguimiento de hoy y se relaciona con el adjunto)" required maxlength="2000" />
              <button class="primaryButton" type="submit">Guardar nota</button>
              <button class="tinyButton ghost" type="button" data-attach-note-cancel>Cancelar</button>
            </form>` : ""}
            <div class="attachDropzone" data-attach-dropzone="${project.id}" tabindex="0" role="button" aria-label="Zona para arrastrar o pegar archivos">
              <span class="attachDropHint">Arrastra o pega un archivo aquí (pantallazo, pdf, csv…)</span>
              <div class="attachAddActions">
                <label class="tinyButton attachFileBtn">+ Archivo
                  <input type="file" data-attach-file="${project.id}" data-attach-update="" accept="${ATTACH_ACCEPT}" hidden multiple />
                </label>
                <button type="button" class="tinyButton ghost" data-attach-query-toggle="${project.id}">${queryOpen ? "Cancelar" : "+ Query"}</button>
              </div>
            </div>
            ${queryOpen ? `
            <form class="inlineForm attachQueryForm" data-attach-query-form="${project.id}">
              <input name="title" type="text" placeholder="Título (opcional)" maxlength="120" />
              <textarea name="text" rows="3" placeholder="Pega aquí el query o el texto" required maxlength="20000"></textarea>
              <button class="primaryButton" type="submit">Guardar query</button>
            </form>` : ""}
            ${uploading ? `<p class="attachStatus" role="status">Subiendo…</p>` : ""}
            ${error ? `<p class="attachStatus error" role="alert">${escapeHtml(error)}</p>` : ""}
          </section>`;
      }

      function renderAttachmentItem(project, att) {
        const del = renderDeleteIconButton("Eliminar adjunto", `data-attach-delete="${project.id}:${att.id}"`);
        const relate = renderAttachRelate(project, att);
        if (att.kind === "query") {
          const label = att.title || "Query";
          return `
            <div class="attachItem query" data-attach-id="${att.id}">
              <button type="button" class="attachOpen" data-attach-query-view="${project.id}:${att.id}" title="Ver query">
                <span class="attachIcon" aria-hidden="true">{ }</span>
                <span class="attachName">${escapeHtml(label)}</span>
              </button>
              ${relate}
              ${del}
            </div>`;
        }
        const icon = isImageName(att.fileName) ? "🖼" : "📄";
        return `
          <div class="attachItem file" data-attach-id="${att.id}">
            <button type="button" class="attachOpen" data-attach-open="${project.id}:${att.id}" title="Ver ${escapeAttribute(att.fileName || "archivo")}">
              <span class="attachIcon" aria-hidden="true">${icon}</span>
              <span class="attachName">${escapeHtml(att.fileName || "archivo")}</span>
            </button>
            ${relate}
            ${del}
          </div>`;
      }

      // Selector "Relacionar con": General (default) + cada entrada de seguimiento
      // (fecha + vista previa del texto) + "+ Nueva nota…" (crea un seguimiento y
      // liga el adjunto a él). Opcional: si no se toca, el adjunto queda General.
      function renderAttachRelate(project, att) {
        const ref = `${project.id}:${att.id}`;
        const updates = project.updates || [];
        // Si el updateId apunta a una entrada borrada, se muestra como General.
        const known = !att.updateId || updates.some((u) => u.id === att.updateId);
        const opts = [`<option value="" ${(!att.updateId || !known) ? "selected" : ""}>General</option>`];
        for (const u of updates) {
          const preview = attachTextPreview(u.text);
          const label = `${updateDateLabel(u.date)}${preview ? ` · "${preview}"` : ""}`;
          opts.push(`<option value="${u.id}" ${att.updateId === u.id ? "selected" : ""}>${escapeHtml(label)}</option>`);
        }
        opts.push(`<option value="__newnote__">+ Nueva nota…</option>`);
        return `<select class="attachRelate" data-attach-relate="${ref}" aria-label="Relacionar adjunto con un seguimiento">${opts.join("")}</select>`;
      }
      function attachTextPreview(text) {
        const t = (text || "").replace(/\s+/g, " ").trim();
        return t.length > 40 ? `${t.slice(0, 40)}…` : t;
      }

      function renderTaskSummary(project) {
        return state.workspace.taskStatuses
          .map((status) => {
            const count = project.tasks.filter((task) => task.status === status.key).length;
            return `${count} ${status.label.toLowerCase()}`;
          })
          .join(" · ");
      }

      function renderTaskColumn(status, project, peopleById) {
        const tasks = project.tasks.filter((task) => task.status === status.key);
        const cards = tasks.map((task) => renderTaskCard(task, peopleById)).join("");
        return `
          <section class="kanbanColumn ${taskStatusClass(status.key)}" data-task-status="${status.key}" data-task-project="${project.id}">
            <header>
              <strong>${status.label}</strong>
              <span>${tasks.length}</span>
            </header>
            <div class="taskDropZone">${cards || `<p class="emptyText">Sin tareas.</p>`}</div>
          </section>
        `;
      }

      function renderTaskCard(task, peopleById) {
        const assignee = task.assigneePersonId ? peopleById[task.assigneePersonId] : null;
        const isSelected = state.selectedDetail?.type === "task" && state.selectedDetail.id === task.id;
        const assigneeAction = assignee ? "Cambiar" : "Asignar";
        return `
          <article class="taskCard ${isSelected ? "selected" : ""}" draggable="true" data-task-id="${task.id}" data-task-select="${task.id}">
            <div class="cardHeader">
              <strong>${escapeHtml(task.title)}</strong>
              ${renderEditIconButton("Editar tarea", `data-detail-task="${task.id}" data-detail-task-project="${task.projectId}"`)}
            </div>
            <div class="taskMeta">
              ${task.priority ? `<span class="priorityBadge ${priorityClass(task.priority)}">${priorityLabel(task.priority)}</span>` : ""}
              ${assignee ? `
                <span
                  class="assigneeChip"
                  draggable="true"
                  data-task-assignee-chip="${task.id}"
                  data-task-assignee-project="${task.projectId}"
                  data-task-assignee-person="${task.assigneePersonId}"
                >${escapeHtml(assignee.fullName)}</span>
              ` : `<small>Sin responsable</small>`}
              <button class="tinyButton subtle" type="button" data-detail-task="${task.id}" data-detail-task-project="${task.projectId}" data-focus-task-assignee="true">${assigneeAction}</button>
            </div>
            <small>Arrastra para cambiar estado.</small>
          </article>
        `;
      }

      function renderDetailPanel(activeProject, peopleById) {
        const detail = getSelectedDetail(activeProject);
        if (!detail) {
          return "";
        }

        if (detail.type === "person") {
          return renderPersonDetail(detail.item);
        }
        if (detail.type === "project") {
          return renderProjectDetail(detail.item, peopleById);
        }
        return renderTaskDetail(detail.item, peopleById);
      }

      function renderProjectInlineDetail(project, peopleById) {
        if (!state.selectedDetail) {
          return "";
        }
        if (state.selectedDetail.type === "project" && state.selectedDetail.id === project.id) {
          return renderProjectDetail(project, peopleById);
        }
        if (state.selectedDetail.type !== "task") {
          return "";
        }
        const selectedProjectId = state.selectedDetail.projectId || project.id;
        if (selectedProjectId !== project.id) {
          return "";
        }
        const task = project.tasks.find((item) => item.id === state.selectedDetail.id);
        return task ? renderTaskDetail(task, peopleById) : "";
      }

      function renderSelectedPersonDetail() {
        if (state.selectedDetail?.type !== "person" || !state.workspace) {
          return "";
        }
        const person = state.workspace.people.find((item) => item.id === state.selectedDetail.id);
        return person ? renderPersonDetail(person) : "";
      }

      function getSelectedDetail(activeProject) {
        if (!state.selectedDetail || !state.workspace) {
          return null;
        }
        if (state.selectedDetail.type === "person") {
          const person = state.workspace.people.find((item) => item.id === state.selectedDetail.id);
          return person ? { type: "person", item: person } : null;
        }
        if (state.selectedDetail.type === "project") {
          const project = state.workspace.projects.find((item) => item.id === state.selectedDetail.id);
          return project ? { type: "project", item: project } : null;
        }

        const project = state.workspace.projects.find((item) => item.id === (state.selectedDetail.projectId || activeProject?.id));
        const task = project?.tasks.find((item) => item.id === state.selectedDetail.id);
        return task ? { type: "task", item: task } : null;
      }

      function renderPersonDetail(person) {
        const notice = state.saveNotice?.target === `person:${person.id}` ? state.saveNotice.message : "";
        return `
          <aside class="panel detailPanel">
            <div class="detailHeader">
              <div>
                <p class="eyebrow">Persona</p>
                <h2>${escapeHtml(person.fullName)}</h2>
              </div>
              <button class="tinyButton ghost" type="button" data-close-detail>Cancelar</button>
            </div>
            <form id="personDetailForm" class="detailForm" data-person-detail="${person.id}">
              <label>Nombre<input name="firstName" type="text" value="${escapeAttribute(person.fullName)}" required /></label>
              <label>Área<input name="area" type="text" value="${escapeAttribute(person.area)}" /></label>
              <label>Estado
                <select name="status">
                  <option value="" ${person.status ? "" : "selected"}>Ninguno</option>
                  <option value="active" ${person.status === "active" ? "selected" : ""}>Activo</option>
                  <option value="inactive" ${person.status === "inactive" ? "selected" : ""}>Inactivo</option>
                </select>
              </label>
              <label>Vacaciones o disponibilidad<textarea name="availabilityNotes" rows="3">${escapeHtml(person.availabilityNotes)}</textarea></label>
              <label>Notas<textarea name="notes" rows="3">${escapeHtml(person.notes)}</textarea></label>
              <button class="primaryButton" type="submit">Guardar persona</button>
              ${notice ? `<p class="saveFeedback" role="status">${escapeHtml(notice)}</p>` : ""}
            </form>
            <div class="detailDanger">
              <button class="dangerButton" type="button" data-delete-person="${person.id}" data-delete-name="${escapeAttribute(person.fullName)}">Eliminar persona</button>
            </div>
          </aside>
        `;
      }

      function renderProjectDetail(project, peopleById) {
        const notice = state.saveNotice?.target === `project:${project.id}` ? state.saveNotice.message : "";
        return `
          <aside class="panel detailPanel">
            <div class="detailHeader">
              <div>
                <p class="eyebrow">Solicitud</p>
                <h2>${escapeHtml(project.name)}</h2>
              </div>
              <button class="tinyButton ghost" type="button" data-close-detail>Cancelar</button>
            </div>
            <form id="projectDetailForm" class="detailForm" data-project-detail="${project.id}">
              <label>Nombre<input name="name" type="text" value="${escapeAttribute(project.name)}" required /></label>
              <label>Tipo
                <select name="requestType">
                  <option value="" ${project.requestType ? "" : "selected"}>Ninguno</option>
                  <option value="project" ${project.requestType === "project" ? "selected" : ""}>Proyecto</option>
                  <option value="report" ${project.requestType === "report" ? "selected" : ""}>Reporte</option>
                </select>
              </label>
              ${renderAreaField("requestingAreaId", "Área solicitante", project.requestingAreaId)}
              ${renderAreaField("targetAreaId", "Grupo de trabajo", project.targetAreaId)}
              <label>Estado
                <div class="fieldWithActions">
                  <select name="status" data-status-select>
                    ${projectStatusOptions(project.status)}
                  </select>
                  ${renderEditIconButton("Corregir o eliminar el estado", "data-status-fix hidden")}
                </div>
              </label>
              <div class="areaInlineForm statusInlineForm" data-status-form data-mode="create" data-color="" hidden>
                <input type="text" data-status-input placeholder="Nombre del estado (p. ej. En revisión)" aria-label="Nombre del estado" />
                <div class="statusSwatches" data-status-swatches role="group" aria-label="Color del estado">
                  ${(state.workspace.statusColors || []).map((c) => `<button type="button" class="statusSwatch statusTone-${c}" data-color="${c}" title="${statusColorName(c)}" aria-label="${statusColorName(c)}"></button>`).join("")}
                </div>
                <div class="areaInlineActions">
                  <button type="button" class="tinyButton" data-status-save>Guardar estado</button>
                  <button type="button" class="tinyButton ghost" data-status-cancel>Cancelar</button>
                  <button type="button" class="tinyButton danger" data-status-del hidden>Eliminar estado</button>
                </div>
              </div>
              <label>Responsable
                <select name="ownerPersonId">
                  <option value="">Ninguno</option>
                  ${state.workspace.people.map((person) => `<option value="${person.id}" ${person.id === project.ownerPersonId ? "selected" : ""}>${escapeHtml(person.fullName)}</option>`).join("")}
                </select>
              </label>
              <div class="detailRow2">
                <label>Fecha de solicitud<input name="requestDate" type="date" value="${escapeAttribute(project.requestDate || "")}" /></label>
                <label>Fecha de entrega<input name="dueDate" type="date" value="${escapeAttribute(project.dueDate || "")}" /></label>
              </div>
              <label>% de avance
                <input name="progress" type="number" min="0" max="100" step="5" inputmode="numeric" placeholder="—" value="${project.progress === "" || project.progress === undefined ? "" : escapeAttribute(String(project.progress))}" />
              </label>
              ${project.tasks.length ? `<p class="fieldHint">Según tareas: ${Math.round((100 * project.tasks.filter((t) => t.status === "done").length) / project.tasks.length)}% (${project.tasks.filter((t) => t.status === "done").length} de ${project.tasks.length} completadas). Si dejas el campo vacío, el tablero usa este cálculo.</p>` : `<p class="fieldHint">Se muestra en el Tablero de avance. Si la solicitud tuviera tareas, aquí verías el % calculado por tareas.</p>`}
              <label>Descripción<textarea name="description" rows="3">${escapeHtml(project.description)}</textarea></label>
              <button class="primaryButton" type="submit">Guardar solicitud</button>
              ${notice ? `<p class="saveFeedback" role="status">${escapeHtml(notice)}</p>` : ""}
            </form>
            <div class="detailDanger">
              <button class="dangerButton" type="button" data-delete-project="${project.id}" data-delete-name="${escapeAttribute(project.name)}">Eliminar solicitud</button>
            </div>
          </aside>
        `;
      }

      function renderTaskDetail(task, peopleById) {
        const notice = state.saveNotice?.target === `task:${task.id}` ? state.saveNotice.message : "";
        return `
          <aside class="panel detailPanel">
            <div class="detailHeader">
              <div>
                <p class="eyebrow">Tarea</p>
                <h2>${escapeHtml(task.title)}</h2>
              </div>
              <button class="tinyButton ghost" type="button" data-close-detail>Cancelar</button>
            </div>
            <form id="taskDetailForm" class="detailForm" data-task-detail="${task.id}">
              <label>Título<input name="title" type="text" value="${escapeAttribute(task.title)}" required /></label>
              <label>Estado
                <select name="status">
                  ${state.workspace.taskStatuses.map((status) => `<option value="${status.key}" ${status.key === task.status ? "selected" : ""}>${escapeHtml(status.label)}</option>`).join("")}
                </select>
              </label>
              <label>Prioridad
                <select name="priority">
                  <option value="" ${task.priority ? "" : "selected"}>Ninguna</option>
                  ${state.workspace.taskPriorities.map((priority) => `<option value="${priority.key}" ${priority.key === task.priority ? "selected" : ""}>${escapeHtml(priority.label)}</option>`).join("")}
                </select>
              </label>
              <label>Responsable
                <select name="assigneePersonId">
                  <option value="">Ninguno</option>
                  ${state.workspace.people.map((person) => `<option value="${person.id}" ${person.id === task.assigneePersonId ? "selected" : ""}>${escapeHtml(person.fullName)}</option>`).join("")}
                </select>
              </label>
              <label>Notas<textarea name="notes" rows="4">${escapeHtml(task.notes)}</textarea></label>
              <button class="primaryButton" type="submit">Guardar tarea</button>
              ${notice ? `<p class="saveFeedback" role="status">${escapeHtml(notice)}</p>` : ""}
            </form>
            <p class="detailHint">Responsable actual: ${escapeHtml(peopleById[task.assigneePersonId]?.fullName || "Sin responsable")}</p>
            <div class="detailDanger">
              <button class="dangerButton" type="button" data-delete-task="${task.id}" data-delete-task-project="${task.projectId}" data-delete-name="${escapeAttribute(task.title)}">Eliminar tarea</button>
            </div>
          </aside>
        `;
      }

      // Estados: catálogo vivo (etiqueta + color de paleta) desde el backend.
      function projectStatusList() {
        return state.workspace?.projectStatuses || [];
      }
      function projectStatusById(id) {
        return projectStatusList().find((s) => s.id === id) || null;
      }
      function projectStatusOptions(currentStatus) {
        const opts = [`<option value="" ${currentStatus ? "" : "selected"}>Sin estado</option>`];
        for (const s of projectStatusList()) {
          opts.push(`<option value="${s.id}" ${s.id === currentStatus ? "selected" : ""}>${escapeHtml(s.label)}</option>`);
        }
        opts.push(`<option value="__new__">+ Agregar estado…</option>`);
        return opts.join("");
      }

      function projectStatusLabel(status) {
        return projectStatusById(status)?.label || "Sin estado";
      }

      // Color como clase de tono de la paleta (define badge y borde de la tarjeta).
      function projectStatusClass(status) {
        const color = projectStatusById(status)?.color;
        return color ? `statusTone-${color}` : "";
      }
      const STATUS_COLOR_NAMES = { blue: "Azul", green: "Verde", amber: "Ámbar", rose: "Rojo", slate: "Gris", teal: "Turquesa", purple: "Morado", orange: "Naranja" };
      function statusColorName(color) {
        return STATUS_COLOR_NAMES[color] || color;
      }

      function taskStatusClass(status) {
        return `taskStatus-${status || "unknown"}`;
      }

      function priorityClass(priority) {
        return `priority-${priority || "none"}`;
      }

      function bindWorkspaceEvents() {
        const personForm = document.querySelector("#personQuickForm");
        const projectForm = document.querySelector("#projectQuickForm");
        const projectSearch = document.querySelector("#projectSearch");
        const personSearch = document.querySelector("#personSearch");
        const personDetailForm = document.querySelector("#personDetailForm");
        const projectDetailForm = document.querySelector("#projectDetailForm");
        const taskDetailForm = document.querySelector("#taskDetailForm");
        const togglePersonFormButton = document.querySelector("#togglePersonFormButton");

        personForm?.addEventListener("submit", submitPersonForm);
        projectForm?.addEventListener("submit", submitProjectForm);
        projectSearch?.addEventListener("input", (event) => {
          state.projectSearch = event.target.value;
          renderWorkspace();
          requestAnimationFrame(() => {
            const input = document.querySelector("#projectSearch");
            input?.focus();
            input?.setSelectionRange(state.projectSearch.length, state.projectSearch.length);
          });
        });
        personSearch?.addEventListener("input", (event) => {
          state.personSearch = event.target.value;
          renderWorkspace();
          requestAnimationFrame(() => {
            const input = document.querySelector("#personSearch");
            input?.focus();
            input?.setSelectionRange(state.personSearch.length, state.personSearch.length);
          });
        });
        personDetailForm?.addEventListener("submit", submitPersonDetailForm);
        projectDetailForm?.addEventListener("submit", submitProjectDetailForm);
        taskDetailForm?.addEventListener("submit", submitTaskDetailForm);
        togglePersonFormButton?.addEventListener("click", () => {
          const willOpen = !state.showPersonForm;
          state.showPersonForm = willOpen;
          state.saveNotice = null;
          renderWorkspace();
          if (willOpen) {
            requestAnimationFrame(() => document.querySelector("#personQuickForm input[name='firstName']")?.focus());
          }
        });

        for (const button of document.querySelectorAll("[data-project-search-scope]")) {
          button.addEventListener("click", () => {
            const scope = button.dataset.projectSearchScope;
            if (!["all", "projects", "tasks"].includes(scope)) return;
            state.projectSearchScope = scope;   // una sola elección
            renderWorkspace();
          });
        }

        for (const form of document.querySelectorAll("[data-task-quick-project]")) {
          form.addEventListener("submit", submitTaskForm);
        }

        // Seguimiento: registrar (fecha de hoy automática), editar, eliminar, ver todas.
        for (const form of document.querySelectorAll("[data-update-quick-project]")) {
          form.addEventListener("submit", submitUpdateForm);
        }
        for (const form of document.querySelectorAll("[data-update-edit-form]")) {
          form.addEventListener("submit", submitUpdateEditForm);
        }
        for (const button of document.querySelectorAll("[data-update-edit]")) {
          button.addEventListener("click", () => {
            state.updateEditing = { projectId: button.dataset.updateEdit, updateId: button.dataset.updateId };
            renderWorkspace();
          });
        }
        for (const button of document.querySelectorAll("[data-update-cancel]")) {
          button.addEventListener("click", () => {
            state.updateEditing = null;
            renderWorkspace();
          });
        }
        for (const button of document.querySelectorAll("[data-update-delete]")) {
          button.addEventListener("click", () => deleteProjectUpdate(button.dataset.updateDelete, button.dataset.updateId));
        }
        for (const button of document.querySelectorAll("[data-update-toggle]")) {
          button.addEventListener("click", () => {
            const id = button.dataset.updateToggle;
            state.updatesExpanded[id] = !state.updatesExpanded[id];
            renderWorkspace();
          });
        }

        // ── Adjuntos ────────────────────────────────────────────────────────────
        // Selección de archivo(s) (franja "General" y por entrada de seguimiento).
        for (const input of document.querySelectorAll("[data-attach-file]")) {
          input.addEventListener("change", () => {
            const projectId = input.dataset.attachFile;
            const updateId = input.dataset.attachUpdate || "";
            const files = [...(input.files || [])];
            input.value = ""; // permite volver a elegir el mismo archivo
            uploadAttachments(projectId, files, updateId);
          });
        }
        // Arrastrar y pegar sobre la zona de la franja.
        for (const zone of document.querySelectorAll("[data-attach-dropzone]")) {
          const projectId = zone.dataset.attachDropzone;
          zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("dragging"); });
          zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
          zone.addEventListener("drop", (event) => {
            event.preventDefault();
            zone.classList.remove("dragging");
            uploadAttachments(projectId, [...(event.dataTransfer?.files || [])], "");
          });
          zone.addEventListener("paste", (event) => {
            const files = [...(event.clipboardData?.files || [])];
            if (files.length) { event.preventDefault(); uploadAttachments(projectId, files, ""); }
          });
        }
        // "+ Query": abrir/cerrar el formulario de texto.
        for (const button of document.querySelectorAll("[data-attach-query-toggle]")) {
          button.addEventListener("click", () => {
            const projectId = button.dataset.attachQueryToggle;
            state.attachQueryFor = state.attachQueryFor === projectId ? null : projectId;
            renderWorkspace();
          });
        }
        for (const form of document.querySelectorAll("[data-attach-query-form]")) {
          form.addEventListener("submit", submitAttachQuery);
        }
        // Ver archivo (abre la presigned GET en otra pestaña).
        for (const button of document.querySelectorAll("[data-attach-open]")) {
          button.addEventListener("click", () => openAttachment(button.dataset.attachOpen));
        }
        // Ver query (muestra el texto y permite copiarlo).
        for (const button of document.querySelectorAll("[data-attach-query-view]")) {
          button.addEventListener("click", () => viewQueryAttachment(button.dataset.attachQueryView));
        }
        for (const button of document.querySelectorAll("[data-attach-delete]")) {
          button.addEventListener("click", () => deleteAttachment(button.dataset.attachDelete));
        }
        // "Relacionar con": General / entrada de seguimiento / + Nueva nota.
        for (const sel of document.querySelectorAll("[data-attach-relate]")) {
          sel.addEventListener("change", () => relateAttachment(sel.dataset.attachRelate, sel.value));
        }
        for (const form of document.querySelectorAll("[data-attach-note-form]")) {
          form.addEventListener("submit", submitAttachNote);
        }
        document.querySelector("[data-attach-note-cancel]")?.addEventListener("click", () => {
          state.attachNoteFor = null;
          renderWorkspace();
        });

        for (const button of document.querySelectorAll("[data-toggle-task-form]")) {
          button.addEventListener("click", () => {
            const projectId = button.dataset.toggleTaskForm;
            const isOpen = state.showTaskForm && state.taskFormProjectId === projectId;
            const willOpen = !isOpen;
            state.showTaskForm = willOpen;
            state.taskFormProjectId = isOpen ? null : projectId;
            state.activeProjectId = projectId;
            state.saveNotice = null;
            renderWorkspace();
            if (willOpen) {
              requestAnimationFrame(() => document.querySelector(`[data-task-quick-project="${projectId}"] input[name='title']`)?.focus());
            }
          });
        }

        for (const button of document.querySelectorAll("[data-toggle-board]")) {
          button.addEventListener("click", () => {
            const projectId = button.dataset.toggleBoard;
            state.expandedBoardProjectId = state.expandedBoardProjectId === projectId ? null : projectId;
            state.activeProjectId = projectId;
            renderWorkspace();
          });
        }

        for (const button of document.querySelectorAll("[data-project-status-filter]")) {
          button.addEventListener("click", () => {
            state.projectStatusFilter = button.dataset.projectStatusFilter || "all";
            renderWorkspace();
          });
        }

        // Conmutador Gestión | Tablero de avance (los filtros activos se conservan).
        for (const button of document.querySelectorAll("[data-ws-view]")) {
          button.addEventListener("click", () => {
            if (state.workspaceView === button.dataset.wsView) return;
            state.workspaceView = button.dataset.wsView;
            renderWorkspace();
          });
        }
        // Tablero: expandir/colapsar el "¿Qué falta? / ¿Cuándo?" de una solicitud.
        for (const row of document.querySelectorAll("[data-board-toggle]")) {
          row.addEventListener("click", () => {
            const id = row.dataset.boardToggle;
            state.boardExpanded = state.boardExpanded === id ? null : id;
            renderWorkspace();
          });
        }

        // Dropdowns de filtro (Tipo/Área/Responsable/Involucra a).
        for (const sel of document.querySelectorAll("[data-filter]")) {
          sel.addEventListener("change", () => {
            const dim = sel.dataset.filter;
            if (dim === "type") state.projectTypeFilter = sel.value;
            else if (dim === "area") state.projectAreaFilter = sel.value;
            else if (dim === "targetArea") state.projectTargetAreaFilter = sel.value;
            else if (dim === "owner") state.projectOwnerFilter = sel.value;
            else if (dim === "involves") state.projectInvolvesFilter = sel.value;
            renderWorkspace();
          });
        }
        // Popover "Filtros" + cierre al hacer clic fuera (mismo patrón que Columnas).
        document.querySelector("#projectFiltersBtn")?.addEventListener("click", (event) => {
          event.stopPropagation();
          state.projectFiltersMenuOpen = !state.projectFiltersMenuOpen;
          renderWorkspace();
        });
        if (filtersCloser) { document.removeEventListener("click", filtersCloser); filtersCloser = null; }
        if (state.projectFiltersMenuOpen) {
          filtersCloser = (event) => {
            if (!event.target.closest(".projectFilterControl")) {
              state.projectFiltersMenuOpen = false;
              renderWorkspace();
            }
          };
          setTimeout(() => document.addEventListener("click", filtersCloser), 0);
        }
        // Chips: quitar un filtro individual con su ×.
        for (const btn of document.querySelectorAll("[data-chip-remove]")) {
          btn.addEventListener("click", () => {
            const dim = btn.dataset.chipRemove;
            if (dim === "type") state.projectTypeFilter = "all";
            else if (dim === "area") state.projectAreaFilter = "all";
            else if (dim === "targetArea") state.projectTargetAreaFilter = "all";
            else if (dim === "owner") state.projectOwnerFilter = "all";
            else if (dim === "involves") state.projectInvolvesFilter = "all";
            renderWorkspace();
          });
        }
        document.querySelector("#clearProjectFilters")?.addEventListener("click", () => {
          state.projectStatusFilter = "all";
          state.projectTypeFilter = "all";
          state.projectAreaFilter = "all";
          state.projectTargetAreaFilter = "all";
          state.projectOwnerFilter = "all";
          state.projectInvolvesFilter = "all";
          state.projectSearch = "";
          renderWorkspace();
        });

        // Menú "Columnas" (mostrar/ocultar) + cierre al hacer clic fuera.
        document.querySelector("#projectColumnsBtn")?.addEventListener("click", (event) => {
          event.stopPropagation();
          state.projectColumnsMenuOpen = !state.projectColumnsMenuOpen;
          renderWorkspace();
        });
        for (const cb of document.querySelectorAll("[data-col-toggle]")) {
          cb.addEventListener("change", () => {
            state.projectColumns = { ...(state.projectColumns || {}), [cb.dataset.colToggle]: cb.checked };
            saveTablePrefs();
            renderWorkspace();
          });
        }
        // Reordenar columnas (↑/↓ del menú): mueve, persiste y repinta con el
        // menú abierto para seguir acomodando de corrido.
        for (const btn of document.querySelectorAll("[data-col-move]")) {
          btn.addEventListener("click", (event) => {
            event.stopPropagation();
            const [key, dir] = btn.dataset.colMove.split(":");
            moveColumn(key, Number(dir));
            renderWorkspace();
          });
        }
        document.querySelector("[data-col-reset]")?.addEventListener("click", () => {
          state.projectColumns = {};
          state.projectColWidths = {};
          state.projectColOrder = null;
          saveTablePrefs();
          renderWorkspace();
        });
        if (columnsCloser) { document.removeEventListener("click", columnsCloser); columnsCloser = null; }
        if (state.projectColumnsMenuOpen) {
          columnsCloser = (event) => {
            if (!event.target.closest(".projectColumnsControl")) {
              state.projectColumnsMenuOpen = false;
              renderWorkspace();
            }
          };
          setTimeout(() => document.addEventListener("click", columnsCloser), 0);
        }

        // Arrastrar el borde de un encabezado para ajustar el ancho de la columna.
        // Actualiza el <col> en vivo (fluido) y persiste al soltar.
        for (const handle of document.querySelectorAll("[data-col-resize]")) {
          handle.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const key = handle.dataset.colResize;
            const startX = event.clientX;
            const startW = colWidth(key);
            const idx = visibleColumns().findIndex((c) => c.key === key);
            const col = document.querySelectorAll(".projectTable.resizable colgroup col")[idx];
            document.body.classList.add("colResizing");
            const onMove = (moveEvent) => {
              const width = Math.max(60, startW + (moveEvent.clientX - startX));
              state.projectColWidths = { ...(state.projectColWidths || {}), [key]: width };
              if (col) col.style.width = `${width}px`;
            };
            const onUp = () => {
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
              document.body.classList.remove("colResizing");
              saveTablePrefs();
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          });
        }

        for (const button of document.querySelectorAll("[data-project-select]")) {
          button.addEventListener("click", () => {
            state.activeProjectId = button.dataset.projectSelect;
            renderWorkspace();
          });
        }

        for (const th of document.querySelectorAll("[data-proj-sort]")) {
          th.addEventListener("click", () => {
            const key = th.dataset.projSort;
            state.projectSort = (state.projectSort?.key === key)
              ? { key, dir: state.projectSort.dir * -1 }
              : { key, dir: 1 };
            renderWorkspace();
          });
        }

        // Fila de la tabla de proyectos → selecciona y muestra el detalle abajo.
        // Clic normal = seleccionar + peek (el listado no se pierde de vista);
        // clic en el chevron › = ir de lleno al detalle.
        for (const row of document.querySelectorAll("[data-project-row]")) {
          row.addEventListener("click", (event) => {
            const full = Boolean(event.target.closest?.(".projChevron"));
            if (state.activeProjectId === row.dataset.projectRow) {
              revealProjectDetail(full);
              return;
            }
            state.activeProjectId = row.dataset.projectRow;
            state.saveNotice = null;
            renderWorkspace();
            revealProjectDetail(full);
          });
        }

        // Área solicitante: catálogo vivo desde el propio selector — "+ Agregar
        // área nueva…" la crea y "Corregir nombre" arregla una mal escrita (se
        // actualizan las opciones en el DOM sin re-render para no perder los
        // demás campos editados del formulario).
        // Campos de área (solicitante y destino): comparten el MISMO catálogo, así
        // que crear/corregir/eliminar desde cualquiera actualiza los selects de
        // AMBOS en el DOM (sin re-render, para no perder lo demás editado).
        const areaSyncs = [];
        const allAreaSelects = () => [...document.querySelectorAll("select[data-area-select]")];
        for (const areaField of document.querySelectorAll("[data-area-field]")) {
          const areaSelect = areaField.querySelector("select[data-area-select]");
          const areaForm = areaField.querySelector("[data-area-form]");
          const areaFix = areaField.querySelector("[data-area-fix]");
          // "Eliminar" vive DENTRO del mini-formulario de edición (lápiz → formulario
          // → Eliminar): una papelera siempre visible junto al selector hacía ruido.
          const areaDel = areaForm.querySelector("[data-area-del]");
          const areaInput = areaForm.querySelector("[data-area-input]");
          const isRealArea = () => areaSelect.value && areaSelect.value !== "__new__";
          // Solo controla la visibilidad del lápiz. La apertura/cierre del
          // formulario la manejan los handlers de change/cancel/guardar — NO aquí
          // (si no, cerraría el formulario de "Agregar área nueva…" al abrirlo).
          const syncAreaButtons = () => {
            if (areaFix) areaFix.hidden = !isRealArea();
          };
          areaSyncs.push(syncAreaButtons);
          syncAreaButtons();
          areaSelect.addEventListener("change", () => {
            if (areaSelect.value === "__new__") {
              areaForm.hidden = false;
              areaForm.dataset.mode = "create";
              areaInput.value = "";
              if (areaDel) areaDel.hidden = true;
              areaInput.focus();
            } else {
              areaForm.hidden = true;
            }
            syncAreaButtons();
          });
          areaFix?.addEventListener("click", () => {
            areaForm.hidden = false;
            areaForm.dataset.mode = "edit";
            areaInput.value = areaSelect.selectedOptions[0]?.textContent || "";
            if (areaDel) areaDel.hidden = false;
            areaInput.focus();
          });
          areaForm.querySelector("[data-area-cancel]")?.addEventListener("click", () => {
            areaForm.hidden = true;
            if (areaSelect.value === "__new__") areaSelect.value = "";
            syncAreaButtons();
          });
          areaDel?.addEventListener("click", async () => {
            const areaId = areaSelect.value;
            const areaLabel = areaSelect.selectedOptions[0]?.textContent || "";
            if (!areaId || areaId === "__new__") return;
            if (!window.confirm(`¿Eliminar el área "${areaLabel}"?`)) return;
            try {
              await apiRequest(`api/areas/${areaId}`, { method: "DELETE" });
              state.workspace.areas = state.workspace.areas.filter((a) => a.id !== areaId);
              for (const sel of allAreaSelects()) {
                sel.querySelector(`option[value="${areaId}"]`)?.remove();
                if (sel.value === areaId) sel.value = "";
              }
              areaForm.hidden = true;
              areaSyncs.forEach((fn) => fn());
            } catch (error) {
              alert(error.message);
            }
          });
          areaForm.querySelector("[data-area-save]")?.addEventListener("click", async () => {
            const name = areaInput.value.trim();
            if (!name) {
              areaInput.focus();
              return;
            }
            try {
              if (areaForm.dataset.mode === "edit") {
                const areaId = areaSelect.value;
                const payload = await apiRequest(`api/areas/${areaId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ name })
                });
                for (const sel of allAreaSelects()) {
                  const option = sel.querySelector(`option[value="${areaId}"]`);
                  if (option) option.textContent = payload.data.name;
                }
                const local = state.workspace.areas.find((area) => area.id === areaId);
                if (local) local.name = payload.data.name;
              } else {
                const payload = await apiRequest("api/areas", {
                  method: "POST",
                  body: JSON.stringify({ name })
                });
                state.workspace.areas.push(payload.data);
                state.workspace.areas.sort((a, b) => a.name.localeCompare(b.name, "es"));
                for (const sel of allAreaSelects()) {
                  const option = document.createElement("option");
                  option.value = payload.data.id;
                  option.textContent = payload.data.name;
                  sel.insertBefore(option, sel.querySelector('option[value="__new__"]'));
                }
                areaSelect.value = payload.data.id;
              }
              areaForm.hidden = true;
              areaSyncs.forEach((fn) => fn());
            } catch (error) {
              alert(error.message);
            }
          });
        }

        // Estado: catálogo vivo desde el selector (igual que áreas, más color y
        // borrado). "+ Agregar estado…" crea, "Corregir" edita, "Eliminar" borra
        // (el backend impide borrar uno en uso). Se actualiza el select en el DOM
        // sin re-render para no perder lo editado en el resto del formulario.
        const statusSelect = document.querySelector("[data-status-select]");
        const statusForm = document.querySelector("[data-status-form]");
        if (statusSelect && statusForm) {
          const statusFix = document.querySelector("[data-status-fix]");
          // "Eliminar" dentro del mini-formulario (lápiz → formulario → Eliminar),
          // igual que las áreas: sin papelera siempre visible junto al selector.
          const statusDel = statusForm.querySelector("[data-status-del]");
          const statusInput = statusForm.querySelector("[data-status-input]");
          const isRealStatus = () => statusSelect.value && statusSelect.value !== "__new__";
          // Solo el lápiz; la apertura/cierre del formulario la manejan los handlers
          // (si no, cerraría el formulario de "Agregar estado…" al abrirlo).
          const syncStatusButtons = () => {
            if (statusFix) statusFix.hidden = !isRealStatus();
          };
          const pickSwatch = (color) => {
            statusForm.dataset.color = color || "";
            for (const sw of statusForm.querySelectorAll(".statusSwatch")) {
              sw.classList.toggle("selected", sw.dataset.color === color);
            }
          };
          syncStatusButtons();
          statusSelect.addEventListener("change", () => {
            if (statusSelect.value === "__new__") {
              statusForm.hidden = false;
              statusForm.dataset.mode = "create";
              statusInput.value = "";
              if (statusDel) statusDel.hidden = true;
              pickSwatch((state.workspace.statusColors || [])[0] || "slate");
              statusInput.focus();
            } else {
              statusForm.hidden = true;
            }
            syncStatusButtons();
          });
          statusFix?.addEventListener("click", () => {
            const current = projectStatusById(statusSelect.value);
            if (!current) return;
            statusForm.hidden = false;
            statusForm.dataset.mode = "edit";
            statusInput.value = current.label;
            if (statusDel) statusDel.hidden = false;
            pickSwatch(current.color);
            statusInput.focus();
          });
          for (const sw of statusForm.querySelectorAll(".statusSwatch")) {
            sw.addEventListener("click", () => pickSwatch(sw.dataset.color));
          }
          statusForm.querySelector("[data-status-cancel]")?.addEventListener("click", () => {
            statusForm.hidden = true;
            if (statusSelect.value === "__new__") statusSelect.value = "";
            syncStatusButtons();
          });
          statusDel?.addEventListener("click", async () => {
            const current = projectStatusById(statusSelect.value);
            if (!current) return;
            if (!window.confirm(`¿Eliminar el estado "${current.label}"?`)) return;
            try {
              await apiRequest(`api/project-statuses/${current.id}`, { method: "DELETE" });
              state.workspace.projectStatuses = state.workspace.projectStatuses.filter((s) => s.id !== current.id);
              statusSelect.querySelector(`option[value="${current.id}"]`)?.remove();
              statusSelect.value = "";
              statusForm.hidden = true;
              syncStatusButtons();
            } catch (error) {
              alert(error.message);
            }
          });
          statusForm.querySelector("[data-status-save]")?.addEventListener("click", async () => {
            const label = statusInput.value.trim();
            const color = statusForm.dataset.color || "slate";
            if (!label) { statusInput.focus(); return; }
            try {
              if (statusForm.dataset.mode === "edit") {
                const id = statusSelect.value;
                const payload = await apiRequest(`api/project-statuses/${id}`, {
                  method: "PATCH", body: JSON.stringify({ label, color })
                });
                const opt = statusSelect.querySelector(`option[value="${id}"]`);
                if (opt) opt.textContent = payload.data.label;
                const local = state.workspace.projectStatuses.find((s) => s.id === id);
                if (local) { local.label = payload.data.label; local.color = payload.data.color; }
              } else {
                const payload = await apiRequest("api/project-statuses", {
                  method: "POST", body: JSON.stringify({ label, color })
                });
                state.workspace.projectStatuses.push(payload.data);
                state.workspace.projectStatuses.sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label, "es"));
                const opt = document.createElement("option");
                opt.value = payload.data.id;
                opt.textContent = payload.data.label;
                statusSelect.insertBefore(opt, statusSelect.querySelector('option[value="__new__"]'));
                statusSelect.value = payload.data.id;
              }
              statusForm.hidden = true;
              syncStatusButtons();
            } catch (error) {
              alert(error.message);
            }
          });
        }

        // Sección Personas (colapsable; el trabajo diario es sobre proyectos).
        const peopleToggle = document.querySelector("#peopleSectionToggle");
        if (peopleToggle) peopleToggle.addEventListener("click", () => {
          state.peopleSectionOpen = !state.peopleSectionOpen;
          if (!state.peopleSectionOpen) { state.showPersonForm = false; state.personSearch = ""; }
          renderWorkspace();
        });

        // Empty state guiado: lleva el foco al formulario de crear proyecto.
        const emptyCta = document.querySelector("#emptyCreateFocus");
        if (emptyCta) emptyCta.addEventListener("click", () => {
          document.querySelector("#projectQuickForm input[name='name']")?.focus();
        });

        for (const card of document.querySelectorAll("[data-person-id]")) {
          card.addEventListener("dragstart", (event) => {
            event.dataTransfer.setData("text/plain", JSON.stringify({ type: "person", id: card.dataset.personId }));
          });
        }

        for (const chip of document.querySelectorAll("[data-member-drag-person]")) {
          chip.addEventListener("dragstart", (event) => {
            event.stopPropagation();
            event.dataTransfer.setData("text/plain", JSON.stringify({
              type: "projectMember",
              projectId: chip.dataset.memberDragProject,
              personId: chip.dataset.memberDragPerson
            }));
          });
        }

        for (const card of document.querySelectorAll("[data-task-id]")) {
          card.addEventListener("dragstart", (event) => {
            event.dataTransfer.setData("text/plain", JSON.stringify({ type: "task", id: card.dataset.taskId }));
          });
          card.addEventListener("dragover", allowDrop);
          card.addEventListener("drop", dropOnTask);
        }

        for (const chip of document.querySelectorAll("[data-task-assignee-chip]")) {
          chip.addEventListener("dragstart", (event) => {
            event.stopPropagation();
            event.dataTransfer.setData("text/plain", JSON.stringify({
              type: "taskAssignee",
              taskId: chip.dataset.taskAssigneeChip,
              projectId: chip.dataset.taskAssigneeProject,
              personId: chip.dataset.taskAssigneePerson
            }));
          });
        }

        for (const project of document.querySelectorAll("[data-project-id]")) {
          project.addEventListener("dragover", allowDrop);
          project.addEventListener("drop", dropOnProject);
        }

        for (const dropZone of document.querySelectorAll("[data-people-drop-zone]")) {
          dropZone.addEventListener("dragover", allowDrop);
          dropZone.addEventListener("drop", dropOnPeoplePanel);
        }

        for (const column of document.querySelectorAll("[data-task-status]")) {
          column.addEventListener("dragover", allowDrop);
          column.addEventListener("drop", dropOnColumn);
        }

        for (const select of document.querySelectorAll("[data-project-member]")) {
          select.addEventListener("click", (event) => event.stopPropagation());
          select.addEventListener("change", async () => {
            if (!select.value) {
              return;
            }
            try {
              await addProjectMember(select.dataset.projectMember, select.value);
            } catch (error) {
              alert(error.message);
            }
          });
        }

        // Quitar persona del proyecto con un clic (alternativa al drag-and-drop,
        // que era inviable cuando el proyecto queda lejos del listado de arriba).
        for (const button of document.querySelectorAll("[data-member-remove-project]")) {
          button.addEventListener("click", async (event) => {
            event.stopPropagation();
            event.preventDefault();
            try {
              await removeProjectMember(button.dataset.memberRemoveProject, button.dataset.memberRemovePerson);
            } catch (error) {
              alert(error.message);
            }
          });
        }

        for (const button of document.querySelectorAll("[data-detail-person]")) {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            state.saveNotice = null;
            state.selectedDetail = { type: "person", id: button.dataset.detailPerson };
            renderWorkspace();
          });
        }

        for (const button of document.querySelectorAll("[data-detail-project]")) {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            state.saveNotice = null;
            state.selectedDetail = { type: "project", id: button.dataset.detailProject };
            renderWorkspace();
          });
        }

        for (const button of document.querySelectorAll("[data-detail-task]")) {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            state.saveNotice = null;
            state.selectedDetail = { type: "task", id: button.dataset.detailTask, projectId: button.dataset.detailTaskProject || state.activeProjectId };
            renderWorkspace();
            if (button.dataset.focusTaskAssignee) {
              requestAnimationFrame(() => document.querySelector("#taskDetailForm select[name='assigneePersonId']")?.focus());
            }
          });
        }

        for (const button of document.querySelectorAll("[data-delete-person]")) {
          button.addEventListener("click", async (event) => {
            event.stopPropagation();
            const id = button.dataset.deletePerson;
            const name = button.dataset.deleteName || "esta persona";
            if (!window.confirm(`¿Eliminar a "${name}"? También se quitará de las solicitudes donde participe. Esta acción no se puede deshacer.`)) return;
            try {
              await apiRequest(`api/people/${encodeURIComponent(id)}`, { method: "DELETE" });
              if (state.selectedDetail?.type === "person" && state.selectedDetail.id === id) state.selectedDetail = null;
              await refreshWorkspace();
            } catch (error) { alert(error.message); }
          });
        }

        for (const button of document.querySelectorAll("[data-delete-project]")) {
          button.addEventListener("click", async (event) => {
            event.stopPropagation();
            const id = button.dataset.deleteProject;
            const name = button.dataset.deleteName || "esta solicitud";
            if (!window.confirm(`¿Eliminar la solicitud "${name}"? Se borrarán también sus tareas y asignaciones. Esta acción no se puede deshacer.`)) return;
            try {
              await apiRequest(`api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
              if (state.activeProjectId === id) state.activeProjectId = null;
              if (state.selectedDetail?.id === id) state.selectedDetail = null;
              await refreshWorkspace();
            } catch (error) { alert(error.message); }
          });
        }

        for (const button of document.querySelectorAll("[data-delete-task]")) {
          button.addEventListener("click", async (event) => {
            event.stopPropagation();
            const id = button.dataset.deleteTask;
            const projectId = button.dataset.deleteTaskProject || state.activeProjectId;
            const name = button.dataset.deleteName || "esta tarea";
            if (!window.confirm(`¿Eliminar la tarea "${name}"? Esta acción no se puede deshacer.`)) return;
            try {
              await apiRequest(`api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
              if (state.selectedDetail?.type === "task" && state.selectedDetail.id === id) state.selectedDetail = null;
              await refreshWorkspace();
            } catch (error) { alert(error.message); }
          });
        }

        document.querySelector("[data-close-detail]")?.addEventListener("click", () => {
          state.saveNotice = null;
          state.selectedDetail = null;
          renderWorkspace();
        });
      }

      async function submitPersonForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        const unlock = lockSubmit(target);
        try {
          await apiRequest("api/people", {
            method: "POST",
            body: JSON.stringify(Object.fromEntries(form.entries()))
          });
          state.showPersonForm = false;
          state.saveNotice = { target: "person-create", message: "Persona registrada." };
          target.reset();
          await refreshWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function submitProjectForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        const unlock = lockSubmit(target);
        try {
          const payload = await apiRequest("api/projects", {
            method: "POST",
            body: JSON.stringify(Object.fromEntries(form.entries()))
          });
          state.activeProjectId = payload.data.id;
          state.selectedDetail = { type: "project", id: payload.data.id };
          state.saveNotice = { target: `project-create:${payload.data.id}`, message: "Solicitud creada." };
          target.reset();
          await refreshWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function submitPersonDetailForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        const unlock = lockSubmit(target);
        try {
          await updatePerson(target.dataset.personDetail, Object.fromEntries(form.entries()));
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function submitProjectDetailForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        const values = Object.fromEntries(form.entries());
        // "+ Agregar área nueva…" quedó seleccionado sin guardarla: no es un área real.
        if (values.requestingAreaId === "__new__") values.requestingAreaId = "";
        if (values.targetAreaId === "__new__") values.targetAreaId = "";
        // Igual para "+ Agregar estado…" sin haberlo creado.
        if (values.status === "__new__") values.status = "";
        const unlock = lockSubmit(target);
        try {
          await updateProject(target.dataset.projectDetail, values);
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function submitTaskDetailForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        const unlock = lockSubmit(target);
        try {
          await updateTask(target.dataset.taskDetail, Object.fromEntries(form.entries()), state.selectedDetail?.projectId || state.activeProjectId);
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function submitTaskForm(event) {
        event.preventDefault();
        const projectId = event.currentTarget.dataset.taskQuickProject;
        if (!projectId) {
          return;
        }
        const target = event.currentTarget;
        const form = new FormData(target);
        const unlock = lockSubmit(target);
        try {
          await apiRequest(`api/projects/${projectId}/tasks`, {
            method: "POST",
            body: JSON.stringify(Object.fromEntries(form.entries()))
          });
          state.activeProjectId = projectId;
          state.showTaskForm = false;
          state.taskFormProjectId = null;
          state.saveNotice = { target: `task-create:${projectId}`, message: "Tarea creada." };
          target.reset();
          await refreshWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      // Seguimiento: crear (la fecha de HOY la pone el backend), editar y eliminar.
      async function submitUpdateForm(event) {
        event.preventDefault();
        const projectId = event.currentTarget.dataset.updateQuickProject;
        if (!projectId) return;
        const target = event.currentTarget;
        const text = (new FormData(target).get("text") || "").toString().trim();
        if (!text) return;
        const unlock = lockSubmit(target);
        try {
          const payload = await apiRequest(`api/projects/${projectId}/updates`, {
            method: "POST",
            body: JSON.stringify({ text })
          });
          const project = findProject(projectId);
          if (project) {
            project.updates.unshift(payload.data);
            sortProjectUpdates(project);
          }
          state.activeProjectId = projectId;
          target.reset();
          renderWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function submitUpdateEditForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const projectId = target.dataset.updateEditForm;
        const updateId = target.dataset.updateId;
        if (!projectId || !updateId) return;
        const form = new FormData(target);
        const text = (form.get("text") || "").toString().trim();
        const date = (form.get("date") || "").toString();
        if (!text || !date) return;
        const unlock = lockSubmit(target);
        try {
          const payload = await apiRequest(`api/projects/${projectId}/updates/${updateId}`, {
            method: "PATCH",
            body: JSON.stringify({ text, date })
          });
          const project = findProject(projectId);
          if (project) {
            const idx = project.updates.findIndex((item) => item.id === updateId);
            if (idx >= 0) project.updates[idx] = { ...project.updates[idx], ...payload.data };
            sortProjectUpdates(project);
          }
          state.updateEditing = null;
          renderWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function deleteProjectUpdate(projectId, updateId) {
        if (!projectId || !updateId) return;
        if (!window.confirm("¿Eliminar esta entrada de seguimiento? No se puede deshacer.")) return;
        try {
          await apiRequest(`api/projects/${projectId}/updates/${updateId}`, { method: "DELETE" });
          const project = findProject(projectId);
          if (project) project.updates = project.updates.filter((item) => item.id !== updateId);
          state.updateEditing = null;
          renderWorkspace();
        } catch (error) {
          alert(error.message);
        }
      }

      // ── Adjuntos ────────────────────────────────────────────────────────────
      // Subir archivo(s): presign → PUT directo del navegador a S3 → confirm.
      // El binario NUNCA pasa por la API (evita el tope de 10 MB de API Gateway).
      async function uploadAttachments(projectId, files, updateId) {
        if (!projectId || !files.length) return;
        state.activeProjectId = projectId;
        state.attachError = { ...(state.attachError || {}), [projectId]: "" };
        state.attachUploading = { ...(state.attachUploading || {}), [projectId]: true };
        renderWorkspace();
        try {
          for (const file of files) {
            // 1) URL prefirmada para subir.
            const presign = await apiRequest(`api/projects/${projectId}/attachments/presign`, {
              method: "POST",
              body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size })
            });
            const { attachmentId, uploadUrl, contentType } = presign.data;
            // 2) PUT directo a S3 (fetch plano, sin el header Authorization de la API).
            const put = await fetch(uploadUrl, {
              method: "PUT",
              headers: { "content-type": contentType },
              body: file
            });
            if (!put.ok) throw new Error("No se pudo subir el archivo al almacenamiento.");
            // 3) Confirmar: crea el item ATTACHMENT en el backend.
            const confirmed = await apiRequest(`api/projects/${projectId}/attachments`, {
              method: "POST",
              body: JSON.stringify({ kind: "file", attachmentId, fileName: file.name, contentType, size: file.size, updateId: updateId || "" })
            });
            const project = findProject(projectId);
            if (project) project.attachments = [confirmed.data, ...(project.attachments || [])];
          }
        } catch (error) {
          state.attachError = { ...(state.attachError || {}), [projectId]: error.message };
        } finally {
          state.attachUploading = { ...(state.attachUploading || {}), [projectId]: false };
          renderWorkspace();
        }
      }

      async function submitAttachQuery(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const projectId = target.dataset.attachQueryForm;
        if (!projectId) return;
        const form = new FormData(target);
        const text = (form.get("text") || "").toString().trim();
        const title = (form.get("title") || "").toString().trim();
        if (!text) return;
        const unlock = lockSubmit(target);
        try {
          const payload = await apiRequest(`api/projects/${projectId}/attachments`, {
            method: "POST",
            body: JSON.stringify({ kind: "query", text, title })
          });
          const project = findProject(projectId);
          if (project) project.attachments = [payload.data, ...(project.attachments || [])];
          state.attachQueryFor = null;
          state.activeProjectId = projectId;
          renderWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function openAttachment(ref) {
        const [projectId, attachmentId] = (ref || "").split(":");
        if (!projectId || !attachmentId) return;
        try {
          const payload = await apiRequest(`api/projects/${projectId}/attachments/${attachmentId}/url`);
          window.open(payload.data.url, "_blank", "noopener");
        } catch (error) {
          alert(error.message);
        }
      }

      function viewQueryAttachment(ref) {
        const [projectId, attachmentId] = (ref || "").split(":");
        const project = findProject(projectId);
        const att = (project?.attachments || []).find((a) => a.id === attachmentId);
        if (!att) return;
        // Copiado directo al portapapeles (el uso típico de un query adjunto).
        const text = att.text || "";
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text)
            .then(() => window.alert(`Query copiado al portapapeles:\n\n${text}`))
            .catch(() => window.alert(text));
        } else {
          window.alert(text);
        }
      }

      async function deleteAttachment(ref) {
        const [projectId, attachmentId] = (ref || "").split(":");
        if (!projectId || !attachmentId) return;
        if (!window.confirm("¿Eliminar este adjunto? No se puede deshacer.")) return;
        try {
          await apiRequest(`api/projects/${projectId}/attachments/${attachmentId}`, { method: "DELETE" });
          const project = findProject(projectId);
          if (project) project.attachments = (project.attachments || []).filter((a) => a.id !== attachmentId);
          renderWorkspace();
        } catch (error) {
          alert(error.message);
        }
      }

      // Relacionar (o desrelacionar) un adjunto con una entrada de seguimiento.
      // "__newnote__" abre el form para crear una nota nueva (no hace PATCH aún).
      async function relateAttachment(ref, value) {
        const [projectId, attachmentId] = (ref || "").split(":");
        if (!projectId || !attachmentId) return;
        if (value === "__newnote__") {
          state.attachNoteFor = ref;
          renderWorkspace();
          requestAnimationFrame(() => document.querySelector(`[data-attach-note-form="${ref}"] input[name='text']`)?.focus());
          return;
        }
        try {
          const payload = await apiRequest(`api/projects/${projectId}/attachments/${attachmentId}`, {
            method: "PATCH",
            body: JSON.stringify({ updateId: value })
          });
          mergeAttachment(projectId, attachmentId, payload.data);
          renderWorkspace();
        } catch (error) {
          alert(error.message);
          renderWorkspace(); // revierte el <select> a su valor real
        }
      }

      // "+ Nueva nota": crea una entrada de seguimiento (fecha de hoy) y liga el
      // adjunto a ella en un solo gesto.
      async function submitAttachNote(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const ref = target.dataset.attachNoteForm;
        const [projectId, attachmentId] = (ref || "").split(":");
        if (!projectId || !attachmentId) return;
        const text = (new FormData(target).get("text") || "").toString().trim();
        if (!text) return;
        const unlock = lockSubmit(target);
        try {
          const upd = await apiRequest(`api/projects/${projectId}/updates`, {
            method: "POST", body: JSON.stringify({ text })
          });
          const project = findProject(projectId);
          if (project) { project.updates.unshift(upd.data); sortProjectUpdates(project); }
          const rel = await apiRequest(`api/projects/${projectId}/attachments/${attachmentId}`, {
            method: "PATCH", body: JSON.stringify({ updateId: upd.data.id })
          });
          mergeAttachment(projectId, attachmentId, rel.data);
          state.attachNoteFor = null;
          renderWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      function mergeAttachment(projectId, attachmentId, data) {
        const project = findProject(projectId);
        if (!project) return;
        const idx = (project.attachments || []).findIndex((a) => a.id === attachmentId);
        if (idx >= 0) project.attachments[idx] = { ...project.attachments[idx], ...data };
      }

      async function dropOnProject(event) {
        event.preventDefault();
        const data = getDragData(event);
        const projectId = event.currentTarget.dataset.projectId;
        if (data?.type !== "person" || !projectId) {
          return;
        }
        try {
          await addProjectMember(projectId, data.id);
        } catch (error) {
          alert(error.message);
        }
      }

      async function addProjectMember(projectId, personId) {
        await apiRequest(`api/projects/${projectId}/members`, {
          method: "POST",
          body: JSON.stringify({ personId })
        });
        state.activeProjectId = projectId;
        await refreshWorkspace();
      }

      async function dropOnPeoplePanel(event) {
        event.preventDefault();
        event.stopPropagation();
        const data = getDragData(event);

        if (data?.type === "projectMember") {
          try {
            await removeProjectMember(data.projectId, data.personId);
          } catch (error) {
            alert(error.message);
          }
          return;
        }

        const taskId = data?.type === "taskAssignee" ? data.taskId : data?.id;
        const projectId = data?.projectId || state.activeProjectId;
        if (!taskId || !projectId || !["task", "taskAssignee"].includes(data?.type)) {
          return;
        }
        try {
          await updateTask(taskId, { assigneePersonId: "" }, projectId, false);
        } catch (error) {
          alert(error.message);
        }
      }

      async function removeProjectMember(projectId, personId) {
        await apiRequest(`api/projects/${projectId}/members/${personId}`, {
          method: "DELETE"
        });
        if (state.selectedDetail?.type === "person" && state.selectedDetail.id === personId) {
          state.selectedDetail = null;
        }
        state.activeProjectId = projectId;
        await refreshWorkspace();
      }

      async function updatePerson(personId, values) {
        const payload = await apiRequest(`api/people/${personId}`, {
          method: "PATCH",
          body: JSON.stringify(values)
        });
        mergePerson(payload.data);
        state.selectedDetail = { type: "person", id: personId };
        state.saveNotice = { target: `person:${personId}`, message: "✓ Guardado" };
        renderWorkspace();
      }

      async function updateProject(projectId, values) {
        const payload = await apiRequest(`api/projects/${projectId}`, {
          method: "PATCH",
          body: JSON.stringify(values)
        });
        mergeProject(payload.data);
        state.activeProjectId = projectId;
        state.selectedDetail = { type: "project", id: projectId };
        state.saveNotice = { target: `project:${projectId}`, message: "✓ Guardado" };
        renderWorkspace();
      }

      async function dropOnColumn(event) {
        event.preventDefault();
        const data = getDragData(event);
        const status = event.currentTarget.dataset.taskStatus;
        const projectId = event.currentTarget.dataset.taskProject || state.activeProjectId;
        if (data?.type !== "task" || !status) {
          return;
        }
        try {
          await updateTask(data.id, { status }, projectId, false);
        } catch (error) {
          alert(error.message);
        }
      }

      async function dropOnTask(event) {
        event.preventDefault();
        event.stopPropagation();
        const data = getDragData(event);
        const taskId = event.currentTarget.dataset.taskId;
        if (data?.type !== "person" || !taskId) {
          return;
        }
        try {
          await updateTask(taskId, { assigneePersonId: data.id }, state.activeProjectId, false);
        } catch (error) {
          alert(error.message);
        }
      }

      function allowDrop(event) {
        event.preventDefault();
      }

      function getDragData(event) {
        try {
          return JSON.parse(event.dataTransfer.getData("text/plain"));
        } catch {
          return null;
        }
      }

      async function updateTask(taskId, values, projectId = state.activeProjectId, showDetail = true) {
        if (!projectId || !taskId) {
          return;
        }
        const payload = await apiRequest(`api/projects/${projectId}/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify(values)
        });
        const project = findProject(projectId);
        if (project) {
          const idx = project.tasks.findIndex((item) => item.id === taskId);
          if (idx >= 0) project.tasks[idx] = { ...project.tasks[idx], ...payload.data };
        }
        state.activeProjectId = projectId;
        if (showDetail) {
          state.saveNotice = { target: `task:${taskId}`, message: "✓ Guardado" };
          state.selectedDetail = { type: "task", id: taskId, projectId };
        }
        renderWorkspace();
      }

      async function refreshWorkspace() {
        // Mantiene lo ya pintado mientras llega lo nuevo — sin pasar por la
        // pantalla "Cargando" (ese parpadeo hacía sentir lento cada guardado).
        await loadWorkspace();
        renderWorkspace();
      }

      // Máquina de estados del botón Guardar: al clic pasa a "Guardando…"
      // deshabilitado (confirma que el clic entró y evita el doble-submit);
      // la confirmación posterior la da el saveFeedback del re-render.
      function lockSubmit(form) {
        const button = form.querySelector("button[type='submit'], .primaryButton");
        if (!button) return () => {};
        const label = button.textContent;
        button.disabled = true;
        button.textContent = "Guardando…";
        return () => {
          button.disabled = false;
          button.textContent = label;
        };
      }

      // Guardado rápido: fusiona la respuesta del PATCH en el estado local y
      // repinta — sin volver a pedir el workspace completo al backend.
      function mergePerson(person) {
        const people = state.workspace?.people || [];
        const idx = people.findIndex((item) => item.id === person.id);
        if (idx >= 0) people[idx] = { ...people[idx], ...person };
        people.sort((a, b) => a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase(), "es"));
      }

      function mergeProject(project) {
        const projects = state.workspace?.projects || [];
        const idx = projects.findIndex((item) => item.id === project.id);
        if (idx < 0) return;
        // El PATCH de solicitud no devuelve el seguimiento: se conserva el local.
        projects[idx] = { ...projects[idx], ...project, updates: projects[idx].updates };
        projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      }

      function findProject(projectId) {
        return state.workspace?.projects.find((item) => item.id === projectId) || null;
      }

      function sortProjectUpdates(project) {
        project.updates.sort((a, b) => (`${a.date}#${a.createdAt}` < `${b.date}#${b.createdAt}` ? 1 : -1));
      }

      function filterPeople(event) {
        const query = event.target.value.trim().toLowerCase();
        for (const card of document.querySelectorAll(".personCard")) {
          card.hidden = query && !card.textContent.toLowerCase().includes(query);
        }
      }

  return { render: renderWorkspace, refresh: refreshWorkspace };
}
