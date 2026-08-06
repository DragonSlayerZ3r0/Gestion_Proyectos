// @ts-nocheck
// Módulo Proyectos y tareas (workspace). Inyección de dependencias desde el shell.
import { createTimelineModule } from "./timeline";

export function createWorkspaceModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, renderDeleteIconButton, priorityLabel, mdLite, saveWorkspacePrefs } = ctx;

  // Sub-módulo: el diagrama de línea de tiempo de UNA solicitud (patrón de
  // composición de docs/21 — el módulo padre lo instancia y le delega).
  const timelineModule = createTimelineModule({ state, escapeHtml, escapeAttribute });

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
      // Orden MANUAL de filas (2026-07-29): lista de projectId en el orden que el
      // usuario acomodó, más el interruptor del modo. Preferencia personal, igual
      // que el orden de columnas.
      state.projectRowOrder = Array.isArray(saved.rowOrder) ? saved.rowOrder : [];
      state.projectManualOrder = !!saved.manualOrder;
    } catch {
      state.projectColumns = {};
      state.projectColWidths = {};
      state.projectColOrder = null;
      state.projectRowOrder = [];
      state.projectManualOrder = false;
    }
  }
  function saveTablePrefs() {
    try {
      localStorage.setItem(PROJECT_TABLE_LS, JSON.stringify({
        columns: state.projectColumns || {}, widths: state.projectColWidths || {},
        order: state.projectColOrder || null,
        rowOrder: state.projectRowOrder || [], manualOrder: !!state.projectManualOrder,
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

      // Búsqueda y filtros persistidos: se guardan en CADA render en vez de en
      // los ~20 manejadores que los tocan (imposible olvidarse de uno). Es una
      // escritura mínima a sessionStorage, sin costo perceptible.
      function persistPrefs() {
        saveWorkspacePrefs?.({
          projectSearch: state.projectSearch,
          projectSearchScope: state.projectSearchScope,
          projectStatusFilter: state.projectStatusFilter,
          projectTypeFilter: state.projectTypeFilter,
          projectAreaFilter: state.projectAreaFilter,
          projectTargetAreaFilter: state.projectTargetAreaFilter,
          projectOwnerFilter: state.projectOwnerFilter,
          projectInvolvesFilter: state.projectInvolvesFilter,
        });
      }

      async function renderWorkspace() {
        persistPrefs();
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
        // Carga diferida de adjuntos: se piden al tener una solicitud abierta.
        // No bloquea el pintado — llegan y se repinta la sección (2026-07-31).
        if (activeProject) loadAttachments(activeProject.id);
        // El contador NO miente: si la anclada (recién creada) no casa con los
        // filtros, se muestra igual pero no se suma al conteo, y se dice por qué
        // aparece una fila que no cumple lo filtrado.
        const pinnedOutOfFilter = !!state.pinnedProjectId
          && !getFilteredProjects(
            workspace.projects.filter((p) => p.id === state.pinnedProjectId), peopleById).length;
        const projectCountText = `${visibleProjects.length - (pinnedOutOfFilter ? 1 : 0)} de ${workspace.projects.length} solicitudes`;
        const personCreatedNotice = state.saveNotice?.target === "person-create" ? state.saveNotice.message : "";
        const visiblePeople = getVisiblePeople(workspace.people);
        const personDirectory = renderPeopleDirectory(visiblePeople);
        const peopleCountText = state.personSearch.trim()
          ? `${visiblePeople.length} de ${workspace.people.length}`
          : String(workspace.people.length);
        const selectedPersonDetail = renderSelectedPersonDetail();
        // El árbol de adjuntos tiene scroll propio y este repintado lo reconstruye
        // desde cero: sin guardar la posición, marcar un archivo de más abajo
        // devolvía la vista al inicio. El caso de desplegar una carpeta ni pasa
        // por aquí (usa repintarArbol), pero seleccionar y borrar sí (2026-08-04).
        const arbolScroll = document.querySelector(".attachTree")?.scrollTop || 0;

        // TRES vistas: "Gestión" (trabajar la lista: tabla, detalle, tareas),
        // "Tablero de avance" (reportar/presentar: barras, qué falta, cuándo) y
        // "Personas" (el directorio completo). Gestión y Tablero comparten la
        // MISMA barra de filtros — filtras en una, presentas en otra; Personas no
        // los usa: filtran solicitudes, no gente.
        // El directorio dejó de vivir al FINAL del detalle (2026-08-04): ahí caía
        // pegado a "Personas relacionadas" —las de ESA solicitud— y las dos se
        // leían como lo mismo. Como vista hermana el alcance es evidente, y se
        // llega en un clic en vez de recorrer todo el detalle. Sigue en este
        // módulo a propósito: dar de alta a un externo (proveedor) NO puede
        // depender de un administrador; Personal es para el control de ausencias
        // y vacaciones, que es otro trabajo.
        const view = state.workspaceView || "manage";
        const isBoard = view === "board";
        const isPeople = view === "people";
        const viewToggle = `
          <div class="wsHeroActions">
            <div class="searchScope segmented wsViewToggle" role="group" aria-label="Vista de solicitudes">
              <button type="button" class="scopeSeg ${view === "manage" ? "active" : ""}" data-ws-view="manage">Gestión</button>
              <button type="button" class="scopeSeg ${isBoard ? "active" : ""}" data-ws-view="board">Tablero de avance</button>
              <button type="button" class="scopeSeg ${isPeople ? "active" : ""}" data-ws-view="people">Personas</button>
            </div>
            <button type="button" id="wsReportBtn" class="wsReportBtn" title="Generar reporte ejecutivo con IA"><span aria-hidden="true">📊</span><span class="wsReportBtnLabel"> Reporte ejecutivo</span></button>
          </div>`;

        elements.contentPanel.innerHTML = `
          <section class="projectOverview">
            <section class="panel workspaceHero">
              <div class="workspaceHeroTop">
                <div class="workspaceHeroText">
                  <p class="eyebrow">Vista operativa</p>
                  <h2>Solicitudes</h2>
                  <p>${isPeople
                    ? "Directorio de todas las personas, internas y externas (proveedores). También puedes registrar a alguien sin salir de una solicitud, desde su selector «Agregar persona»."
                    : isBoard ? "Avance por solicitud, listo para presentar. Usa los filtros para acotar lo que se muestra."
                    : "Elige una solicitud de la lista para ver sus personas, tareas y seguimiento."}</p>
                </div>
                ${viewToggle}
              </div>
              ${isBoard || isPeople ? "" : `
              <!-- CREAR vs BUSCAR (2026-07-29): dos trabajos distintos NO pueden
                   verse igual. Crear es ocasional → vive detrás de un botón
                   primario que abre el formulario (mismo patrón que "Registrar
                   persona"/"Crear tarea" de este módulo). Buscar es constante →
                   se queda siempre visible, con lupa. La diferencia es de FORMA
                   y peso, no de color: se lee igual en escala de grises. -->
              <div class="wsCreateRow">
                <!-- Abierto, el botón pasa a SECUNDARIO: "Cancelar" no puede
                     competir con "Crear" (dos rellenos de acento apilados en
                     móvil se leían como dos acciones principales). -->
                <button type="button" id="projectCreateToggle"
                  class="${state.showProjectForm ? "secondaryButton" : "primaryButton"} compact"
                  aria-expanded="${state.showProjectForm ? "true" : "false"}">
                  ${state.showProjectForm ? "Cancelar" : "+ Nueva solicitud"}
                </button>
              </div>
              ${state.showProjectForm ? `
              <form id="projectQuickForm" class="projectCreateForm">
                <input name="name" type="text" placeholder="Nombre de la solicitud" required />
                <select name="requestType" aria-label="Tipo de solicitud">
                  ${requestTypes().map((t) => `<option value="${t.key}">${escapeHtml(t.label)}</option>`).join("")}
                </select>
                <button class="primaryButton" type="submit">Crear</button>
              </form>` : ""}`}
              ${isPeople ? "" : `
              <div class="workspaceControls wsSearchBlock">
                <div class="wsSearchRow">
                  <span class="wsSearchIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4.5 4.5"></path></svg>
                  </span>
                  <input id="projectSearch" class="searchInput hasIcon" type="search" placeholder="${state.projectAdvanced ? "Escribe una idea y presiona Enter…" : "Buscar por nombre, descripción, persona…"}" value="${escapeAttribute(state.projectSearch)}" />
                  ${state.projectAdvanced ? `<button type="button" id="projectSemGoBtn" class="wsSemGoBtn" title="Buscar por significado (Enter)"><span aria-hidden="true">≈</span> Buscar</button>` : ""}
                  <button type="button" id="projectAdvancedToggle" class="wsAdvancedToggle${state.projectAdvanced ? " active" : ""}" title="Búsqueda avanzada: por significado, incluye lo escrito en los seguimientos (encuentra aunque la palabra no sea exacta)"><span aria-hidden="true">≈</span> Avanzada</button>
                </div>
                ${state.projectAdvanced
                  ? `<p class="wsAdvancedHint">Pregunta en lenguaje natural y presiona <b>Enter</b> (o «Buscar»): entiende <b>condiciones</b> (responsable, estado, área) y busca por <b>significado</b> en solicitudes y sus <b>seguimientos</b>. Ej.: «solicitudes del responsable Diego», «lo que se habló de las APIs», «activas sobre cartera vencida».</p>`
                  : `<div class="searchScopeGroup">
                  <span class="searchScopeLabel">Buscar en:</span>
                  <div class="searchScope segmented" role="group" aria-label="Buscar en">
                    ${renderProjectSearchScopeButton("all", "Todo")}
                    ${renderProjectSearchScopeButton("projects", "Solicitudes")}
                    ${renderProjectSearchScopeButton("tasks", "Tareas")}
                  </div>
                </div>`}
              </div>`}
            </section>

            ${isPeople ? renderPeopleView(workspace, personDirectory, peopleCountText,
                                          personCreatedNotice, selectedPersonDetail) : isBoard ? `
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
                  ${pinnedOutOfFilter ? `<span class="pinnedNote">+1 recién creada, fuera de los filtros actuales</span>` : ""}
                </div>
              </div>
              <div class="projectBoardWrap">${renderProgressBoard(visibleProjects, peopleById)}</div>
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
                  <button class="tinyButton ghost${state.projectManualOrder ? " active" : ""}" type="button" id="projectManualOrderBtn"
                    aria-pressed="${state.projectManualOrder ? "true" : "false"}"
                    title="${state.projectManualOrder ? "Volver al orden automático (tu acomodo se conserva)" : "Acomodar las filas a mano: arrastra o usa ↑/↓"}">⇅ Orden manual</button>
                  <div class="projectColumnsControl">
                    <button class="tinyButton ghost" type="button" id="projectColumnsBtn" aria-haspopup="true" aria-expanded="${state.projectColumnsMenuOpen ? "true" : "false"}">Columnas ▾</button>
                    ${state.projectColumnsMenuOpen ? renderColumnsMenu() : ""}
                  </div>
                  <span class="countPill">${projectCountText}</span>
                  ${pinnedOutOfFilter ? `<span class="pinnedNote">+1 recién creada, fuera de los filtros actuales</span>` : ""}
                </div>
              </div>
              <div class="projectTableWrap">
                ${projectTableContent(visibleProjects, activeProject, peopleById)}
              </div>
            </section>

            ${activeProject ? renderProjectCard(activeProject, true, peopleById) : ""}`}`}
          </section>
        `;

        if (arbolScroll) {
          const arbol = document.querySelector(".attachTree");
          if (arbol) arbol.scrollTop = arbolScroll;
        }
        bindWorkspaceEvents();
      }

      // Vista "Personas": el directorio completo. Ya NO es una sección colapsable
      // al final del detalle (2026-08-04) — es la vista entera, así que va
      // siempre abierta: el chevron no tenía nada que esconder aquí.
      function renderPeopleView(workspace, personDirectory, peopleCountText,
                                personCreatedNotice, selectedPersonDetail) {
        return `
          <section class="panel peopleSection peopleView open">
            <div class="peopleSectionHead">
              <div class="peopleViewTitle">
                <strong>Personas registradas</strong>
                <span class="countPill subtle">${peopleCountText}</span>
              </div>
              <button id="togglePersonFormButton" class="${state.showPersonForm ? "secondaryButton" : "primaryButton"} compact" type="button">${state.showPersonForm ? "Cancelar" : "+ Registrar persona"}</button>
            </div>
            <div class="peopleBody">
              <form id="personQuickForm" class="personCreateForm" ${state.showPersonForm ? "" : "hidden"}>
                <input name="firstName" type="text" placeholder="Nombre completo o proveedor" required />
                <details class="optionalDetails">
                  <summary>Más datos</summary>
                  ${renderAreaField("areaId", "Área", "")}
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
              <p class="peopleHint">Para sumar a alguien a una solicitud, usa el selector «Agregar persona» de esa solicitud — ahí mismo puedes registrar a quien todavía no exista.</p>
              ${selectedPersonDetail ? `<section class="detailDrawerSlot personDetailSlot">${selectedPersonDetail}</section>` : ""}
            </div>
          </section>`;
      }

      async function loadWorkspace() {
        const payload = await apiRequest("api/workspace");
        state.workspace = payload.data;
      }

      // Igual que loadWorkspace pero SIN tocar el estado: se usa cuando el
      // usuario está escribiendo y no se le puede repintar encima.
      async function fetchWorkspaceData() {
        try {
          const payload = await apiRequest("api/workspace");
          return payload.data;
        } catch {
          return null;
        }
      }

      function getVisibleProjects(projects, peopleById) {
        // ANCLA de la recién creada (2026-07-31): una solicitud nueva no tiene
        // estado, ni área, ni responsable, así que CUALQUIER filtro o búsqueda
        // activa la deja fuera de la lista — y con ella desaparece su
        // formulario, que se dibuja dentro de su fila. El usuario la creaba y
        // "se perdía": tenía que cancelar su búsqueda e ir a buscarla por
        // nombre. Se mantiene visible mientras siga anclada; se suelta al
        // cerrar su detalle o al seleccionar otra cosa.
        // El ancla se suelta sola cuando el usuario deja de mirar esa solicitud
        // (selecciona otra o cierra el detalle): así no queda una fila colada en
        // la lista para siempre.
        if (state.pinnedProjectId
            && state.selectedDetail?.id !== state.pinnedProjectId
            && state.activeProjectId !== state.pinnedProjectId) {
          state.pinnedProjectId = null;
        }
        const pinned = state.pinnedProjectId
          ? projects.filter((p) => p.id === state.pinnedProjectId)
          : [];
        const rest = getFilteredProjects(projects, peopleById)
          .filter((p) => p.id !== state.pinnedProjectId);
        return [...pinned, ...rest];
      }

      function getFilteredProjects(projects, peopleById) {
        const query = normalizeSearch(state.projectSearch);
        const typeF = state.projectTypeFilter || "all";
        const areaF = state.projectAreaFilter || "all";
        const targetF = state.projectTargetAreaFilter || "all";
        const ownerF = state.projectOwnerFilter || "all";
        const involvesF = state.projectInvolvesFilter || "all";
        return projects.filter((project) => {
          // Estado: MULTI-selección con OR ([] = todos; "none" = sin estado).
          // "Activo y Planificado a la vez" era imposible con el valor único.
          const stF = state.projectStatusFilter || [];
          if (stF.length) {
            const matches = (stF.includes("none") && !project.status) || stF.includes(project.status);
            if (!matches) return false;
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
          // Búsqueda AVANZADA (planificador): aplica los filtros EXACTOS que
          // entendió (responsable/estado/área/tipo) + el concepto semántico. Así
          // "responsable Diego" filtra exacto por Diego; "tema fraude" ranquea por
          // significado; "de Diego sobre APIs" hace ambas. Se combina además con
          // los filtros manuales de arriba.
          if (state.projectAdvanced && (state.projectSemQuery || "").trim()) {
            const f = state.projectSemFilters || {};
            if (f.status && project.status !== f.status) return false;
            if (f.ownerPersonId && project.ownerPersonId !== f.ownerPersonId) return false;
            if (f.requestingAreaId && project.requestingAreaId !== f.requestingAreaId) return false;
            if (f.requestType && (project.requestType || "") !== f.requestType) return false;
            // Con concepto semántico → solo las que casaron por significado; sin
            // concepto (consulta de puro filtro) → todas las que pasan los filtros.
            if ((state.projectSemConcept || "").trim()) return !!state.projectSemResults[project.id];
            return true;
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

      // El conjunto COMPLETO de estados seleccionables ("none" = sin estado).
      function allStatusIds() {
        return ["none", ...projectStatusList().map((s) => s.id)];
      }

      // Marca explícita de "ningún estado seleccionado". Hace falta un valor
      // distinto de [] porque [] ya significa "todos" (sin filtro) y así se
      // persiste. El centinela no coincide con ninguna solicitud, de modo que
      // la tabla queda vacía sola y la elección sobrevive a la recarga.
      const NO_STATUS_SELECTED = "__ninguno__";

      // Disparador de "+ Registrar persona nueva…" en el selector de miembros.
      // No es un id de persona: abre el mini-formulario (mismo papel que
      // "__new__" en los selectores de Área y Estado).
      const NEW_PERSON_OPTION = "__nueva_persona__";

      // Estados encendidos AHORA MISMO. Resuelve las tres representaciones
      // posibles ([] = todos, [centinela] = ninguno, lista = esos) en una sola
      // respuesta: es la única fuente para dibujar los chips y para calcular
      // el siguiente estado al hacer clic.
      function selectedStatusIds() {
        const stF = state.projectStatusFilter || [];
        if (stF.includes(NO_STATUS_SELECTED)) return [];
        const full = allStatusIds();
        const on = stF.filter((s) => full.includes(s));
        // Sin marcas útiles (o con estados ya borrados del catálogo): todos.
        return on.length ? on : full;
      }

      function noStatusSelected() {
        return (state.projectStatusFilter || []).includes(NO_STATUS_SELECTED);
      }

      // Con cero estados marcados la lista NO puede volver a mostrarlo todo por
      // su cuenta: eso convertiría el clic del usuario en un no-op inexplicable.
      // Se dice por qué está vacía y se ofrece la salida en el mismo lugar donde
      // está mirando.
      function noStatusNotice() {
        return `<p class="emptyText projectTableEmpty">Ningún estado seleccionado. <button type="button" class="filterChip filterChip--action" data-project-status-filter="all">Ver todos</button></p>`;
      }

      function renderProjectStatusFilters() {
        // COHERENCIA VISUAL (2026-07-29): si la tabla muestra todos los estados,
        // TODOS los chips se ven encendidos — el dibujo no puede contradecir al dato.
        //
        // MODELO DE INTERACCIÓN (2026-07-30, tras revisar usabilidad): la fila es
        // un juego de CASILLAS. Encendido = incluido; un clic SIEMPRE alterna ese
        // estado. Antes el primer clic AISLABA (apagaba los otros siete), así que
        // ocultar un solo estado —lo más frecuente en una bandeja larga: "sin los
        // cerrados"— costaba siete clics. Ocho chips encendidos PARECEN casillas
        // pero se comportaban como botones de radio: forma y conducta no
        // coincidían, y esa es la molestia que reportó el usuario.
        //
        // El chip líder es una ACCIÓN, no un valor: dice lo que hará ("Ninguno"
        // cuando están todos, "Todos" cuando falta alguno), así aislar cuesta 2
        // clics (Ninguno → el que quieras) sin esconder nada tras un gesto.
        // Se descartó el doble clic para aislar: es invisible (nadie lo descubre
        // solo), no existe al tocar —el doble tap es zoom—, excluye a quien tiene
        // poca motricidad fina, y sobre un interruptor son DOS alternancias que se
        // cancelan: habría que retrasar cada clic ~250 ms o repintar en falso.
        const full = allStatusIds();
        const on = selectedStatusIds();
        const showingAll = on.length === full.length;
        const master = `
            <button
              class="filterChip filterChip--action"
              type="button"
              data-project-status-filter="all"
              title="${showingAll ? "Quitar todos los estados" : "Ver todos los estados"}"
            >${showingAll ? "Ninguno" : "Todos"}</button>`;
        const chips = [
          ["none", "Sin estado"],
          ...projectStatusList().map((s) => [s.id, s.label])
        ]
          .map(([status, label]) => {
            const active = on.includes(status);
            return `
            <button
              class="filterChip ${active ? "active" : ""}"
              type="button"
              data-project-status-filter="${status}"
              aria-pressed="${active ? "true" : "false"}"
              title="${escapeAttribute(active ? `Quitar ${label}` : `Agregar ${label}`)}"
            >${label}</button>`;
          })
          .join("");
        return `<span class="projectFiltersLabel">Estado:</span>${master}${chips}`;
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
            ${requestTypes().map((t) => `<option value="${t.key}" ${typeV === t.key ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("")}
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
        if (typeF !== "all") chips.push(chip("type", "Tipo", typeF === "__none__" ? "Sin tipo" : (requestTypeLabel(typeF) || typeF)));
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
        return (state.projectStatusFilter || []).length > 0
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
      // Catálogo de tipos desde el PAYLOAD (fuente única en backend/services/
      // workspace.py → REQUEST_TYPES_CATALOG): agregar un tipo allá lo propaga a
      // los 3 selects (nuevo/filtro/detalle), etiquetas de columna y chips. El
      // fallback local solo cubre el instante de un deploy cruzado.
      const REQUEST_TYPES_FALLBACK = [
        { key: "project", label: "Proyecto" },
        { key: "report", label: "Reporte" },
        { key: "requirement", label: "Requerimiento" },
      ];
      function requestTypes() {
        return state.workspace?.requestTypes?.length ? state.workspace.requestTypes : REQUEST_TYPES_FALLBACK;
      }
      function requestTypeLabel(value) {
        return requestTypes().find((t) => t.key === value)?.label || "";
      }

      // Área solicitante: catálogo vivo (quién pide la solicitud). Las solicitudes
      // guardan el id; el nombre se resuelve aquí, así corregir un área mal escrita
      // corrige todas las solicitudes que la usan.
      // ── Encabezados de sección (2026-07-31) ─────────────────────────────────
      // Los cuatro bloques del detalle (Adjuntos, Personas, Tareas, Seguimiento)
      // tenían el MISMO marco, fondo y título: para encontrar uno había que
      // LEER las cuatro etiquetas, y leer es lento. Un ícono por sección da una
      // marca de FORMA, que el ojo localiza antes de leer.
      // Se descartó darle un color a cada bloque: en esta app el color significa
      // algo (acento = acción principal, tonos = estados) y además no ayuda a
      // quien tiene deficiencia de visión al color. La forma funciona en escala
      // de grises y para todos — mismo criterio que «crear vs. buscar».
      const SECTION_ICONS = {
        adjuntos: `<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>`,
        personas: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>`,
        tareas: `<path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>`,
        seguimiento: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h5"></path>`,
      };

      function blockHeaderHtml(iconKey, title, count) {
        const icon = SECTION_ICONS[iconKey] || "";
        return `
          <div class="blockHeader">
            <strong>
              <svg class="blockHeaderIcon" viewBox="0 0 24 24" width="16" height="16" fill="none"
                stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                aria-hidden="true">${icon}</svg>
              ${escapeHtml(title)}
            </strong>
            <span>${count}</span>
          </div>`;
      }

      // ¿Puede MANTENER los catálogos (crear/corregir/eliminar áreas y estados)?
      // Sub-permiso `projects_catalogos` o el módulo Administración — el mismo OR
      // que evalúa el guard del backend en workspace_routes. Sin esto el usuario
      // solo ELIGE de la lista: ocultar la opción evita ofrecer algo que sería un
      // 403, pero la autoridad real siempre es el backend.
      function canManageCatalogs() {
        const profile = state.profile;
        if ((profile?.capabilities || []).includes("projects_catalogos")) return true;
        return (profile?.modules || []).some((m) => m.key === "admin" && m.enabled !== false);
      }

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
        if (canManageCatalogs()) {
          options.push(`<option value="__new__">+ Agregar área nueva…</option>`);
        }
        return options.join("");
      }

      // Campo de área reutilizable (Área solicitante y Grupo de trabajo comparten
      // el MISMO catálogo AREA): selector + lápiz (corregir) + papelera (eliminar, el
      // backend la protege si está en uso) + mini-formulario inline.
      function renderAreaField(name, label, selectedId) {
        // Sin permiso de catálogo el campo es SOLO un selector: ni lápiz ni
        // mini-formulario. No se dejan escondidos en el DOM — el cableado se
        // salta el campo cuando no hay formulario (mismo criterio que Estado).
        const manage = canManageCatalogs();
        return `
          <div class="areaField" data-area-field>
            <label>${escapeHtml(label)}
              <div class="fieldWithActions">
                <select name="${name}" data-area-select>
                  ${areaOptions(selectedId)}
                </select>
                ${manage ? renderEditIconButton("Corregir o eliminar el área", "data-area-fix hidden") : ""}
              </div>
            </label>
            ${manage ? `
            <div class="areaInlineForm" data-area-form data-mode="create" hidden>
              <input type="text" data-area-input placeholder="${escapeAttribute(AREA_EXAMPLE)}" aria-label="Nombre del área" />
              <div class="areaInlineActions">
                <button type="button" class="tinyButton" data-area-save>Guardar área</button>
                <button type="button" class="tinyButton ghost" data-area-cancel>Cancelar</button>
                <button type="button" class="tinyButton danger" data-area-del hidden>Eliminar área</button>
              </div>
            </div>` : ""}
          </div>`;
      }

      // Orden por columna (clic en el encabezado: 1º asc, 2º desc). Sin orden
      // elegido se mantiene el del backend (última solicitud actualizada primero).
      // Mueve una solicitud `delta` posiciones dentro del orden manual actual.
      // `visibleIds` es el orden que el usuario TIENE EN PANTALLA: se toma como
      // base para que el arrastre sea predecible aunque haya filtros aplicados.
      function moveProjectRow(projectId, delta, visibleIds) {
        const base = [...(visibleIds || [])];
        const from = base.indexOf(projectId);
        if (from < 0) return;
        const to = Math.max(0, Math.min(base.length - 1, from + delta));
        if (to === from) return;
        base.splice(to, 0, base.splice(from, 1)[0]);
        applyManualOrder(base);
      }

      // Coloca `dragId` en la posición de `targetId` (arrastre).
      function dropProjectRow(dragId, targetId, visibleIds) {
        const base = [...(visibleIds || [])];
        const from = base.indexOf(dragId);
        const to = base.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return;
        base.splice(to, 0, base.splice(from, 1)[0]);
        applyManualOrder(base);
      }

      // Fusiona el orden de lo VISIBLE con el guardado: lo que está filtrado fuera
      // conserva su posición relativa (mover con un filtro puesto no revuelve el resto).
      function applyManualOrder(visibleOrder) {
        const previous = state.projectRowOrder || [];
        const visible = new Set(visibleOrder);
        const merged = [];
        let i = 0;
        for (const id of previous) {
          if (visible.has(id)) {                 // hueco de un visible → toma el siguiente del orden nuevo
            if (i < visibleOrder.length) merged.push(visibleOrder[i++]);
          } else {
            merged.push(id);                     // no visible: se queda donde estaba
          }
        }
        while (i < visibleOrder.length) merged.push(visibleOrder[i++]);
        state.projectRowOrder = merged;
        state.projectManualOrder = true;
        state.projectSort = null;                // el orden manual reemplaza al de columna
        saveTablePrefs();
        renderWorkspace();
      }

      function sortProjectsForTable(projects, peopleById) {
        const s = state.projectSort;
        // ORDEN MANUAL (2026-07-29): manda sobre cualquier otro criterio mientras
        // el modo esté encendido. Las solicitudes que no estén en la lista guardada
        // (nuevas, o nunca movidas) van al FINAL conservando su orden natural — así
        // acomodar unas pocas no obliga a ordenar las 82.
        if (state.projectManualOrder) {
          const pos = new Map((state.projectRowOrder || []).map((id, i) => [id, i]));
          return [...projects].sort((a, b) => {
            const ia = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
            const ib = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
            return ia - ib;
          });
        }
        // Avanzada CON concepto semántico y sin orden de columna → por RELEVANCIA.
        // (Consulta de puro filtro, sin concepto → orden por defecto del backend.)
        if (!s && state.projectAdvanced && (state.projectSemConcept || "").trim()) {
          const scoreOf = (p) => state.projectSemResults[p.id]?.score ?? -1;
          return [...projects].sort((a, b) => scoreOf(b) - scoreOf(a));
        }
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
          case "name": {
            // Clip discreto SOLO si hay adjuntos (patrón correo): monocromo tenue,
            // sin columna propia ni color — es un indicio, no un estado (docs/06).
            // El conteo viene en el workspace; la LISTA se carga al abrir la
            // solicitud (2026-07-31), así el listado no arrastra su metadata.
            const attCount = project.attachmentsCount || 0;
            // ANCLADO al borde derecho de la celda (no pegado al texto): con
            // nombres largos que envuelven, al final del texto quedaba en posición
            // variable y "se perdía"; antes del título rompería la alineación
            // izquierda del identificador. Fijo a la derecha, los clips forman su
            // propio riel vertical escaneable (patrón correo).
            const clip = attCount ? `<span class="projClip" title="${attCount} adjunto${attCount === 1 ? "" : "s"}" aria-label="${attCount} adjunto${attCount === 1 ? "" : "s"}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16.5 6.5v9a4.5 4.5 0 0 1-9 0v-10a3 3 0 0 1 6 0v9.5a1.5 1.5 0 0 1-3 0V7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>` : "";
            // En búsqueda avanzada, si la coincidencia vino de un SEGUIMIENTO,
            // un chip discreto con el fragmento (el keyword no busca ahí).
            const hit = state.projectAdvanced ? state.projectSemResults[project.id] : null;
            let semChip = "";
            if (hit && hit.via === "seguimiento") {
              const upd = (project.updates || []).find((u) => u.id === hit.updateId);
              const snippet = (upd?.text || "").slice(0, 90);
              semChip = `<span class="projSemHit" title="${escapeAttribute(snippet || "Coincide en un seguimiento")}">≈ seguimiento</span>`;
            }
            // `title` nativo: con la tabla de ancho fijo el nombre largo se
            // recorta con elipsis, así que el completo debe poder verse al pasar
            // el mouse (antes se perdía sin manera de leerlo).
            return `<td class="projName" title="${escapeAttribute(project.name)}"><span class="projNameText">${escapeHtml(project.name)}</span>${semChip}${clip}</td>`;
          }
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

      // Muestra QUÉ entendió el planificador (filtros exactos + concepto), para que
      // el usuario sepa por qué se filtró/ordenó así.
      function interpretationBanner() {
        const interp = (state.projectSemInterpretation || "").trim();
        if (!interp) return "";
        return `<p class="wsSemInterp"><span class="wsSemInterpIcon" aria-hidden="true">≈</span> Entendí: ${escapeHtml(interp)}</p>`;
      }

      // Contenido del contenedor de la tabla, contemplando los estados de la
      // búsqueda avanzada (cargando / error / sin consulta / sin coincidencias).
      function projectTableContent(projects, activeProject, peopleById) {
        if (state.projectAdvanced) {
          if (state.projectSemLoading) return `<p class="emptyText projectTableEmpty">Interpretando y buscando…</p>`;
          if (state.projectSemError) return `<p class="emptyText projectTableEmpty">${escapeHtml(state.projectSemError)}</p>`;
          const q = (state.projectSemQuery || "").trim();
          if (!q) return `<p class="emptyText projectTableEmpty">Escribe una idea o una condición y presiona <b>Enter</b> (o «Buscar»). Ej.: «solicitudes del responsable Diego», «lo que se habló de las APIs», «activas sobre fraude».</p>`;
          const banner = interpretationBanner();
          if (!projects.length) {
            return banner + (noStatusSelected()
              ? noStatusNotice()
              : `<p class="emptyText projectTableEmpty">Sin coincidencias para «${escapeHtml(q)}». Ajusta la consulta o revisa los filtros activos.</p>`);
          }
          return banner + renderProjectTable(projects, activeProject, peopleById);
        }
        return renderProjectTable(projects, activeProject, peopleById);
      }

      function renderProjectTable(projects, activeProject, peopleById) {
        if (!projects.length) {
          if (noStatusSelected()) return noStatusNotice();
          return `<p class="emptyText projectTableEmpty">No hay resultados con los filtros actuales.</p>`;
        }
        const cols = visibleColumns();
        const manual = !!state.projectManualOrder;
        // En modo manual se agrega una PRIMERA columna con el asa de arrastre y
        // las flechas ↑/↓ (docs/06: todo drag & drop necesita alternativa visible).
        const colgroup = `<colgroup>${manual ? `<col style="width:64px" />` : ""}${cols.map((c) => `<col style="width:${colWidth(c.key)}px" />`).join("")}<col style="width:32px" /></colgroup>`;
        const head = cols.map((c) => projSortTh(c.key, c.label, c.num ? "num" : "")).join("");
        const ordered = sortProjectsForTable(projects, peopleById);
        const visibleIds = ordered.map((p) => p.id);
        const rows = ordered.map((project, index) => {
          const selected = activeProject?.id === project.id;
          const cells = cols.map((c) => renderProjectCell(c.key, project, peopleById)).join("");
          const handle = manual ? `
            <td class="projOrderCell">
              <span class="projDragHandle" draggable="true" data-project-drag="${project.id}" title="Arrastra para mover esta fila" aria-hidden="true">⠿</span>
              <span class="projOrderBtns">
                <button type="button" class="colMoveBtn" data-project-move-up="${project.id}" ${index === 0 ? "disabled" : ""} aria-label="Subir ${escapeAttribute(project.name)}" title="Subir">↑</button>
                <button type="button" class="colMoveBtn" data-project-move-down="${project.id}" ${index === ordered.length - 1 ? "disabled" : ""} aria-label="Bajar ${escapeAttribute(project.name)}" title="Bajar">↓</button>
              </span>
            </td>` : "";
          return `
            <tr class="projectRow ${selected ? "selected" : ""}${manual ? " manualOrder" : ""}" data-project-row="${project.id}" data-project-id="${project.id}" title="Ver detalle de ${escapeAttribute(project.name)}">
              ${handle}${cells}
              <td class="projChevron" title="Ir al detalle">${selected ? "▾" : "›"}</td>
            </tr>`;
        }).join("");
        // El orden visible se guarda para que los manejadores sepan sobre qué
        // lista mover (con filtros puestos, mover es relativo a lo que se ve).
        state._projectVisibleIds = visibleIds;
        return `
          <table class="projectTable resizable">
            ${colgroup}
            <thead>
              <tr>${manual ? `<th class="projOrderTh" title="Orden manual">Orden</th>` : ""}${head}<th class="projChevronTh" aria-hidden="true"></th></tr>
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
          // Promedio del % de CADA tarea (2026-07-24). Si ninguna tarea tiene %
          // manual, cada una vale 100 (completada) o 0 → el promedio es idéntico
          // al cálculo anterior "completadas/total": compatible hacia atrás, y
          // ahora una tarea a medias aporta su avance real.
          const total = project.tasks.reduce((sum, t) => sum + taskProgress(t).pct, 0);
          return { pct: Math.round(total / project.tasks.length), source: "tareas" };
        }
        return { pct: null, source: "none" };
      }

      // % de avance de UNA tarea: manda el manual; si no está definido se deriva
      // del estado (completada = 100, cualquier otro = 0), que es lo que la
      // solicitud usaba históricamente para su cálculo por tareas.
      function taskProgress(task) {
        if (task.progress !== "" && task.progress !== undefined && task.progress !== null) {
          return { pct: Number(task.progress), source: "manual" };
        }
        return { pct: task.status === "done" ? 100 : 0, source: "estado" };
      }

      // Tablero de avance: informe ejecutivo para presentar. Estatus por estado
      // (del conjunto FILTRADO), barras 0-100% agrupadas por área solicitante,
      // y al clic el detalle "¿Qué falta? / ¿Cuándo?" (tareas pendientes + entrega).
      function renderProgressBoard(projects, peopleById) {
        if (!projects.length) {
          if (noStatusSelected()) return noStatusNotice();
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

      // "Agregar persona" + "+ Registrar persona nueva…" en el MISMO selector
      // (2026-08-04): el caso real es estar llenando la solicitud y necesitar un
      // proveedor externo que aún no existe. Antes había que ir al directorio,
      // registrarlo y volver a asignarlo. Es el patrón que ya usan Área y Estado.
      // El selector se pinta SIEMPRE (aunque no queden personas libres): si no,
      // la única puerta para registrar desaparecía justo cuando hacía falta.
      function renderMemberPicker(project, availablePeople) {
        const creating = state.memberCreateFor === project.id;
        return `
          <select class="projectMemberSelect inline" data-project-member="${project.id}" aria-label="Agregar persona a la solicitud">
            <option value="">Agregar persona</option>
            ${availablePeople.map((person) => `<option value="${person.id}">${escapeHtml(person.fullName)}</option>`).join("")}
            <option value="${NEW_PERSON_OPTION}">+ Registrar persona nueva…</option>
          </select>
          ${!availablePeople.length && !creating
            ? `<p class="emptyText helperText">Todas las personas registradas ya están en esta solicitud.</p>` : ""}
          ${creating ? `
          <div class="memberCreateForm" data-member-create="${project.id}">
            <input type="text" data-member-create-input maxlength="120"
              placeholder="Nombre completo o proveedor" aria-label="Nombre de la persona nueva" />
            <div class="memberCreateActions">
              <button type="button" class="tinyButton" data-member-create-save>Registrar y agregar</button>
              <button type="button" class="tinyButton ghost" data-member-create-cancel>Cancelar</button>
            </div>
            <p class="emptyText helperText">Queda en el directorio de personas y agregada a esta solicitud.</p>
          </div>` : ""}`;
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
                  <!-- Encabezado = acciones sobre la SOLICITUD completa. Las de
                       TAREAS (crear, tablero, entregable) viven en la tarjeta
                       Tareas, pegadas a lo que afectan (2026-07-31). -->
                  <div class="projectActions">
                    <button class="tinyButton ghost" type="button" data-timeline-project="${project.id}" title="Ver la línea de tiempo de esta solicitud">Línea de tiempo</button>
                    <button class="tinyButton ghost" type="button" data-detail-project="${project.id}">Editar solicitud</button>
                  </div>
                </div>
              </div>

              ${renderProjectAttachments(project)}

              <div class="projectOverviewGrid">
                <section class="projectPeopleBlock">
                  ${blockHeaderHtml("personas", "Personas relacionadas", project.members.length)}
                  <div class="memberChipList spacious">
                    ${memberChips || `<span class="emptyText">Agrega personas a la solicitud.</span>`}
                  </div>
                  ${renderMemberPicker(project, availablePeople)}
                </section>

                <section class="projectSummaryBlock">
                  ${blockHeaderHtml("tareas", "Tareas", project.tasks.length)}
                  <p>${summary}</p>
                  <!-- TODO lo de tareas junto: conteo, acciones y el alta. Antes
                       «Crear tarea» y «Ver tablero» estaban en el encabezado, a
                       media pantalla de aquí y mezclados con «Editar solicitud»,
                       que no tiene que ver con tareas. -->
                  <div class="taskBlockActions">
                    <button class="tinyButton" type="button" data-toggle-task-form="${project.id}">${taskFormOpen ? "Cancelar" : "Crear tarea"}</button>
                    <button class="tinyButton ghost" type="button" data-toggle-board="${project.id}">${boardOpen ? "Ocultar tablero" : "Ver tablero"}</button>
                    ${deliverablesOf(project).length ? "" : `
                      <button type="button" class="tinyButton ghost" data-deliverable-new="${project.id}"
                        title="Agrupar las tareas en entregables (útil en solicitudes grandes)">+ Entregable</button>`}
                  </div>
                  <form class="inlineForm projectTaskForm" data-task-quick-project="${project.id}" ${taskFormOpen ? "" : "hidden"}>
                    <input name="title" type="text" placeholder="Nueva tarea" required />
                    <button class="primaryButton" type="submit">Crear tarea</button>
                  </form>
                </section>
              </div>

              ${renderProjectUpdates(project)}

              ${cardNotice ? `<p class="saveFeedback compactFeedback" role="status">${escapeHtml(cardNotice)}</p>` : ""}

              ${renderDeliverablesStrip(project)}

              ${boardOpen ? `
                <p class="boardHint">Arrastra una tarjeta de una columna a otra para cambiar su estado. También puedes hacerlo desde el detalle de la tarea.</p>
                <div class="kanbanBoard compactBoard">${columns}</div>` : ""}
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
        const entryAtts = (attachmentsOf(project.id) || []).filter((a) => a.updateId === u.id);
        // Si la entrada tiene una CARPETA relacionada, se resume en UN chip: al
        // relacionar 89 archivos de golpe, pintar 89 chips convertiría la
        // bitácora en una pared ilegible (2026-07-31). Los sueltos siguen igual.
        const porCarpeta = new Map();
        const sueltos = [];
        for (const a of entryAtts) {
          const raiz = (a.path || "").split("/")[0];
          if (raiz) porCarpeta.set(raiz, (porCarpeta.get(raiz) || 0) + 1);
          else sueltos.push(a);
        }
        // El chip de carpeta ES un botón y lleva a esa carpeta ya desplegada en la
        // franja Adjuntos. Como <span> heredaba el cursor: pointer del chip, así
        // que se veía clicable y no hacía nada: botón muerto (2026-08-04).
        const folderChips = [...porCarpeta.entries()].map(([nombre, n]) =>
          `<button type="button" class="attachChip attachChipFolder" data-attach-goto-folder="${
            escapeAttribute(`${project.id}::${nombre}`)}" title="${escapeAttribute(
            `${n} ${n === 1 ? "archivo" : "archivos"} en ${nombre} — abrir en Adjuntos`)}"` +
          `><span class="attachChipIcon" aria-hidden="true">🗀</span><span class="attachChipName">${
            escapeHtml(nombre)}</span><em>${n}</em></button>`).join("");
        const attachChips = folderChips + sueltos.map((a) => {
          const isQuery = a.kind === "query";
          const open = isQuery
            ? `data-attach-query-view="${project.id}:${a.id}"`
            : `data-attach-open="${project.id}:${a.id}"`;
          const icon = isQuery ? "{ }" : (isImageName(a.fileName) ? "🖼" : "📄");
          const name = isQuery ? (a.title || "Query") : (a.fileName || "archivo");
          return `<button type="button" class="attachChip attachChipOpen" ${open} title="Ver ${escapeAttribute(name)}"` +
            `><span class="attachChipIcon" aria-hidden="true">${icon}</span><span class="attachChipName">${escapeHtml(name)}</span></button>`;
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
            ${blockHeaderHtml("seguimiento", "Seguimiento", updates.length)}
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

      // Sin filtro `accept`: se sube casi cualquier binario de trabajo (Excel,
      // Word, parquet, zip…) — el backend bloquea SOLO ejecutables/scripts y
      // páginas activas (blocklist en services/attachments.py, 2026-07-08).
      const ATTACH_IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif"];
      function isImageName(name) {
        const ext = (name || "").split(".").pop().toLowerCase();
        return ATTACH_IMAGE_EXT.includes(ext);
      }
      // Franja "Adjuntos" (índice): vive en el encabezado del detalle, junta TODOS
      // los adjuntos de la solicitud (archivos + queries) con su etiqueta de origen.
      // Subir un adjunto "General" y crear queries se hace desde aquí; adjuntar CON
      // contexto se hace dentro de cada entrada de Seguimiento (renderUpdateRow).
      // ── Adjuntos: carga diferida + árbol de carpetas (2026-07-31) ───────────
      function attachmentsOf(projectId) {
        return state.projectAttachments[projectId] || null;   // null = sin cargar
      }

      // Se pide al ABRIR la solicitud. Una sola vez por solicitud y sesión: si
      // ya están en memoria no se vuelve a pedir (el guardado de un adjunto
      // actualiza la lista en sitio).
      async function loadAttachments(projectId) {
        if (!projectId) return;
        if (state.projectAttachments[projectId] || state.attachmentsLoading[projectId]) return;
        state.attachmentsLoading[projectId] = true;
        try {
          const payload = await apiRequest(`api/projects/${projectId}/attachments`);
          state.projectAttachments[projectId] = payload.data || [];
        } catch (error) {
          state.attachError = { ...(state.attachError || {}), [projectId]: error.message };
          state.projectAttachments[projectId] = [];
        } finally {
          state.attachmentsLoading[projectId] = false;
          renderWorkspace();
        }
      }

      function attachName(att) {
        return att.kind === "query" ? (att.title || "Query sin título") : (att.fileName || "archivo");
      }

      function pesoLegible(bytes) {
        const n = Number(bytes || 0);
        if (!n) return "";
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
      }

      // Árbol derivado de las RUTAS: no hay entidad carpeta que mantener.
      function buildAttachTree(atts) {
        const raiz = { folders: new Map(), files: [] };
        for (const att of atts) {
          const partes = (att.path || "").split("/").filter(Boolean);
          let nodo = raiz;
          for (const parte of partes) {
            if (!nodo.folders.has(parte)) nodo.folders.set(parte, { folders: new Map(), files: [] });
            nodo = nodo.folders.get(parte);
          }
          nodo.files.push(att);
        }
        return raiz;
      }

      function contarNodo(nodo) {
        let n = nodo.files.length;
        for (const hijo of nodo.folders.values()) n += contarNodo(hijo);
        return n;
      }

      function hojasDe(nodo, out = []) {
        out.push(...nodo.files);
        for (const hijo of nodo.folders.values()) hojasDe(hijo, out);
        return out;
      }

      function renderProjectAttachments(project) {
        const atts = attachmentsOf(project.id) || [];
        const queryOpen = state.attachQueryFor === project.id;
        const uploading = !!(state.attachUploading && state.attachUploading[project.id]);
        const error = state.attachError ? state.attachError[project.id] : "";
        const cargando = !!state.attachmentsLoading[project.id];
        const q = (state.attachSearch || "").trim().toLowerCase();
        const marcados = atts.filter((a) => state.attachSelected[a.id]);
        const pesoTotal = atts.reduce((s, a) => s + Number(a.size || 0), 0);
        const carpetas = new Set(atts.map((a) => (a.path || "").split("/")[0]).filter(Boolean)).size;
        return `
          <section class="attachBlock" data-attach-project="${project.id}">
            ${blockHeaderHtml("adjuntos", "Adjuntos", atts.length)}
            ${atts.length > 8 || q ? `
              <input type="text" class="attachSearch" data-attach-search
                placeholder="Buscar por nombre de archivo o carpeta" value="${escapeAttribute(state.attachSearch || "")}" />` : ""}
            ${marcados.length ? `
              <div class="attachSelBar">
                <span>${marcados.length} ${marcados.length === 1 ? "archivo seleccionado" : "archivos seleccionados"}</span>
                <span class="attachSelActions">
                  <button type="button" class="tinyButton" data-attach-zip="${project.id}">Descargar .zip</button>
                  <button type="button" class="tinyButton ghost" data-attach-unselect>Quitar selección</button>
                </span>
              </div>` : ""}
            <div class="attachTree">
              ${cargando ? `<p class="emptyText">Cargando adjuntos…</p>`
                : (atts.length ? renderAttachTree(project, atts, q)
                  : `<span class="emptyText">Sin adjuntos. Agrega pantallazos, archivos o queries de la solicitud.</span>`)}
            </div>
            ${atts.length ? `<p class="attachFoot">${
              carpetas ? `${carpetas} ${carpetas === 1 ? "carpeta" : "carpetas"} · ` : ""
            }${atts.length} ${atts.length === 1 ? "archivo" : "archivos"}${
              pesoTotal ? ` · ${pesoLegible(pesoTotal)}` : ""}</p>` : ""}
            ${(state.attachNoteFor || "").startsWith(`${project.id}:`) ? `
            <form class="inlineForm attachNoteForm" data-attach-note-form="${state.attachNoteFor}">
              <input name="text" type="text" placeholder="Nota (se registra como seguimiento de hoy y se relaciona con el adjunto)" required maxlength="2000" />
              <button class="primaryButton" type="submit">Guardar nota</button>
              <button class="tinyButton ghost" type="button" data-attach-note-cancel>Cancelar</button>
            </form>` : ""}
            <div class="attachDropzone" data-attach-dropzone="${project.id}" tabindex="0" role="button" aria-label="Zona para arrastrar o pegar archivos">
              <span class="attachDropHint">Arrastra o pega un archivo aquí (pantallazo, Excel, pdf, csv…)</span>
              <div class="attachAddActions">
                <label class="tinyButton attachFileBtn">+ Archivo
                  <input type="file" data-attach-file="${project.id}" data-attach-update="" hidden multiple />
                </label>
                <label class="tinyButton attachFileBtn">+ Carpeta
                  <input type="file" data-attach-folder-input="${project.id}" hidden multiple webkitdirectory directory />
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
            ${state.attachProgress && state.attachProgress.projectId === project.id ? `
              <div class="attachProgress" role="status">
                <div class="attachProgressHead">
                  <span data-attach-progress-text>${
                    state.attachProgress.hechos < state.attachProgress.total
                      ? `Subiendo ${state.attachProgress.hechos} de ${state.attachProgress.total}`
                      : `${state.attachProgress.total - state.attachProgress.fallidos.length} de ${state.attachProgress.total} subidos`}</span>
                </div>
                <div class="attachProgressTrack"><span data-attach-progress-bar style="width:${
                  Math.round((state.attachProgress.hechos * 100) / state.attachProgress.total)}%"></span></div>
                ${state.attachProgress.terminado && state.attachProgress.fallidos.length ? `
                  <p class="attachProgressFail">${state.attachProgress.fallidos.length} ${
                    state.attachProgress.fallidos.length === 1 ? "archivo falló" : "archivos fallaron"}:
                    ${escapeHtml(state.attachProgress.fallidos.slice(0, 3).map((f) => f.nombre).join(", "))}${
                      state.attachProgress.fallidos.length > 3 ? "…" : ""}
                    <button type="button" class="tinyButton ghost" data-attach-progress-close>Entendido</button></p>` : ""}
              </div>` : ""}
            ${uploading ? `<p class="attachStatus" role="status">Subiendo…</p>` : ""}
            ${error ? `<p class="attachStatus error" role="alert">${escapeHtml(error)}</p>` : ""}
          </section>`;
      }

      // Con búsqueda activa se APLANA: con muchos archivos nadie navega el
      // árbol, busca — y cada resultado necesita su ruta para ubicarse.
      function renderAttachTree(project, atts, q) {
        if (q) {
          const hits = atts.filter((a) =>
            `${attachName(a)} ${a.path || ""}`.toLowerCase().includes(q));
          if (!hits.length) {
            return `<p class="emptyText">Ningún adjunto coincide con «${escapeHtml(q)}».</p>`;
          }
          return hits.map((a) => renderAttachRow(project, a, 0, a.path || "")).join("");
        }
        return renderAttachNodo(project, buildAttachTree(atts), 0, "");
      }

      // Iconos del árbol en SVG inline. Antes eran los glifos 🗀 y 🗎 (U+1F5C0 /
      // U+1F5CE): mal soportados, se dibujaban casi idénticos y con ellos no se
      // distinguía una carpeta de un archivo de un vistazo (2026-08-04). El SVG
      // hereda el color con currentColor y se ve igual en cualquier sistema.
      const TREE_ICONS = {
        carpeta: `<svg class="attachFolderIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
          fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path
          d="M3 7.5a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1.2 1.3H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
        archivo: `<svg class="attachIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
          fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path
          d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`,
      };

      function renderAttachNodo(project, nodo, nivel, ruta) {
        const carpetas = [...nodo.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        const archivos = [...nodo.files].sort((a, b) => attachName(a).localeCompare(attachName(b)));
        const html = carpetas.map(([nombre, hijo]) => {
          const rutaHija = ruta ? `${ruta}/${nombre}` : nombre;
          // Solo el primer nivel abierto: con cinco carpetas ves la estructura
          // completa en cinco renglones y el volumen no se te impone.
          const clave = `${project.id}::${rutaHija}`;
          const abierta = state.attachTreeOpen[clave] !== undefined
            ? state.attachTreeOpen[clave]
            : nivel === 0 && carpetas.length <= 1;
          const hojas = hojasDe(hijo);
          const marcadas = hojas.filter((a) => state.attachSelected[a.id]).length;
          const estado = marcadas === 0 ? "vacia" : (marcadas === hojas.length ? "todas" : "parcial");
          return `
            <div class="attachNode">
              <div class="attachRow attachFolder" style="padding-left:${8 + nivel * 18}px">
                <button type="button" class="attachCheck ${estado}" data-attach-check-folder="${escapeAttribute(rutaHija)}"
                  data-attach-check-project="${project.id}"
                  aria-label="Seleccionar el contenido de ${escapeAttribute(nombre)}">${
                    estado === "todas" ? "☑" : (estado === "parcial" ? "◪" : "☐")}</button>
                <button type="button" class="attachFolderBtn" data-attach-folder="${escapeAttribute(clave)}">
                  <span class="attachChevron">${abierta ? "▾" : "▸"}</span>
                  ${TREE_ICONS.carpeta}
                  <span class="attachFolderName">${escapeHtml(nombre)}</span>
                  <span class="attachCount">${contarNodo(hijo)}</span>
                </button>
                ${renderFolderRelate(project, rutaHija, hojas)}
              </div>
              ${abierta ? `<div class="attachKids" style="--guia:${8 + nivel * 18 + 9}px">${
                renderAttachNodo(project, hijo, nivel + 1, rutaHija)}</div>` : ""}
            </div>`;
        }).join("");
        return html + archivos.map((a) => renderAttachRow(project, a, nivel, "")).join("");
      }

      function renderAttachRow(project, att, nivel, rutaVisible) {
        const nombre = attachName(att);
        const marcado = !!state.attachSelected[att.id];
        const meta = [att.createdByName || att.createdBy, updateDateLabel(att.createdAt?.slice(0, 10)),
                      pesoLegible(att.size)].filter(Boolean).join(" · ");
        // Marca de referenciado: sin ella, borrar desde el árbol haría
        // desaparecer un chip de la bitácora sin que nadie lo previera.
        const ref = att.updateId
          ? `<span class="attachRefMark" title="Referenciado en un seguimiento" aria-label="Referenciado en un seguimiento">🔗</span>`
          : "";
        return `
          <div class="attachRow attachFile ${marcado ? "isSel" : ""}" style="padding-left:${8 + nivel * 18}px" data-attach-id="${att.id}">
            <button type="button" class="attachCheck ${marcado ? "todas" : "vacia"}"
              data-attach-check="${att.id}" aria-label="Seleccionar ${escapeAttribute(nombre)}">${marcado ? "☑" : "☐"}</button>
            <button type="button" class="attachOpenBtn" ${att.kind === "query"
              ? `data-attach-query-open="${project.id}:${att.id}"` : `data-attach-open="${project.id}:${att.id}"`}
              title="${escapeAttribute(att.kind === "query" ? "Ver la query" : `Abrir ${nombre}`)}">
              ${att.kind === "query" ? `<span class="attachIcon isQuery" aria-hidden="true">{ }</span>` : TREE_ICONS.archivo}
              <span class="attachName">${escapeHtml(nombre)}${ref}${
                rutaVisible ? `<span class="attachPath"> · ${escapeHtml(rutaVisible)}</span>` : ""}</span>
            </button>
            <span class="attachMeta">${escapeHtml(meta)}</span>
            ${renderAttachRelate(project, att)}
            ${renderDeleteIconButton("Eliminar adjunto", `data-attach-delete="${project.id}:${att.id}" data-attach-ref="${att.updateId ? "1" : ""}"`)}
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
      // Relacionar la CARPETA COMPLETA (2026-07-31). Con 89 archivos subidos de
      // una vez, el seguimiento es de la ENTREGA, no de cada archivo: pedirlo
      // uno por uno sería inviable. Si todos sus archivos ya apuntan a la misma
      // entrada, el selector lo refleja; si están mezclados, muestra «Varios».
      function renderFolderRelate(project, ruta, hojas) {
        const updates = project.updates || [];
        if (!updates.length || !hojas.length) return "";
        const ids = new Set(hojas.map((a) => a.updateId || ""));
        const comun = ids.size === 1 ? [...ids][0] : null;
        const opts = [`<option value="" ${comun === "" ? "selected" : ""}>General</option>`];
        for (const u of updates) {
          const preview = attachTextPreview(u.text);
          const label = `${updateDateLabel(u.date)}${preview ? ` · "${preview}"` : ""}`;
          opts.push(`<option value="${u.id}" ${comun === u.id ? "selected" : ""}>${escapeHtml(label)}</option>`);
        }
        if (comun === null) opts.unshift(`<option value="__varios__" selected>Varios</option>`);
        return `<select class="attachRelate attachRelateFolder" data-attach-relate-folder="${escapeAttribute(ruta)}"
          data-attach-relate-project="${project.id}" data-attach-relate-count="${hojas.length}"
          aria-label="Relacionar toda la carpeta con un seguimiento">${opts.join("")}</select>`;
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

      // ── Entregables (2026-07-31) ────────────────────────────────────────────
      // Nivel OPCIONAL para las solicitudes grandes: agrupa tareas y muestra el
      // avance de cada frente. Si la solicitud NO tiene entregables, nada de
      // esto se dibuja — con 1 a 3 tareas (30 de las 41 solicitudes con tareas)
      // sería complejidad regalada.
      function deliverablesOf(project) {
        return project?.deliverables || [];
      }

      function deliverableName(project, deliverableId) {
        return deliverablesOf(project).find((d) => d.id === deliverableId)?.name || "";
      }

      // Tareas visibles del tablero: todas, o solo las del entregable enfocado.
      function boardTasks(project) {
        const focus = state.deliverableFilter;
        if (!focus || !deliverablesOf(project).length) return project.tasks;
        return project.tasks.filter((task) => (task.deliverableId || "") === focus);
      }

      // Avance del entregable = PROMEDIO del % de sus tareas, la misma regla que
      // ya usa el "% por tareas" de la solicitud (nada nuevo que explicar).
      function deliverableStats(project, deliverableId) {
        const tasks = project.tasks.filter((t) => (t.deliverableId || "") === deliverableId);
        const done = tasks.filter((t) => t.status === "done").length;
        const pct = tasks.length
          ? Math.round(tasks.reduce((sum, t) => sum + taskProgress(t).pct, 0) / tasks.length)
          : 0;
        return { total: tasks.length, done, pct };
      }

      function renderDeliverablesStrip(project) {
        const items = deliverablesOf(project);
        // El formulario vive DENTRO de esta franja, así que también hay que
        // dibujarla cuando todavía no hay ningún entregable pero el usuario
        // acaba de pulsar «+ Entregable»: si no, ese botón —el ÚNICO camino
        // para crear el primero— no hace nada visible (bug 2026-07-31).
        const formOpen = state.deliverableFormProject === project.id;
        if (!items.length && !formOpen) return "";
        const focus = state.deliverableFilter;
        // Solo tiene sentido señalar "tareas sueltas" si ya hay con qué agrupar.
        const sinEntregable = items.length
          ? project.tasks.filter((t) => !t.deliverableId).length
          : 0;
        const rows = items.map((d) => {
          const { total, done, pct } = deliverableStats(project, d.id);
          const active = focus === d.id;
          // El lápiz va FUERA del botón de la fila: un <button> dentro de otro
          // es HTML inválido y el navegador puede reordenar el DOM.
          return `
            <div class="entRow ${active ? "active" : ""}">
              <button type="button" class="entRowMain" data-deliverable="${d.id}" data-deliverable-project="${project.id}"
                aria-pressed="${active ? "true" : "false"}"
                title="${escapeAttribute(active ? "Ver todas las tareas" : `Ver solo las tareas de ${d.name}`)}">
                <span class="entName">${escapeHtml(d.name)}</span>
                <span class="entDate">${d.dueDate ? escapeHtml(updateDateLabel(d.dueDate)) : "—"}</span>
                <span class="entBar"><span style="width:${pct}%"></span></span>
                <span class="entPct">${pct}%</span>
                <span class="entCount">${done}/${total}</span>
              </button>
              ${renderEditIconButton("Corregir o eliminar el entregable", `data-deliverable-edit="${d.id}" data-deliverable-edit-project="${project.id}"`)}
            </div>`;
        }).join("");
        return `
          <section class="entPanel" data-deliverables-project="${project.id}">
            <div class="entHead">
              <strong>Entregables</strong>
              ${focus ? `<button type="button" class="tinyButton ghost" data-deliverable-clear="${project.id}">Ver todas las tareas</button>` : ""}
              <button type="button" class="tinyButton ghost" data-deliverable-new="${project.id}">+ Agregar entregable</button>
            </div>
            <div class="entList">${rows}</div>
            ${sinEntregable ? `<p class="entLoose">${sinEntregable} ${sinEntregable === 1 ? "tarea sin entregable" : "tareas sin entregable"}</p>` : ""}
            ${renderDeliverableForm(project)}
          </section>`;
      }

      // Alta y edición del entregable en el MISMO mini-formulario (nombre +
      // fecha), con "Eliminar" adentro — el patrón que ya usan área y estado.
      function renderDeliverableForm(project) {
        if (state.deliverableFormProject !== project.id) return "";
        const editing = state.deliverableEditing
          ? deliverablesOf(project).find((d) => d.id === state.deliverableEditing)
          : null;
        const { total } = editing ? deliverableStats(project, editing.id) : { total: 0 };
        return `
          <div class="entForm" data-deliverable-form="${project.id}">
            <input type="text" data-deliverable-name maxlength="80"
              placeholder="Nombre del entregable (p. ej. Pipeline de datos)"
              aria-label="Nombre del entregable" value="${escapeAttribute(editing?.name || "")}" />
            <label class="entFormDate">Fecha
              <input type="date" data-deliverable-date value="${escapeAttribute(editing?.dueDate || "")}" />
            </label>
            <div class="entFormActions">
              <button type="button" class="tinyButton" data-deliverable-save="${project.id}">${editing ? "Guardar" : "Crear entregable"}</button>
              <button type="button" class="tinyButton ghost" data-deliverable-cancel>Cancelar</button>
              ${editing ? `<button type="button" class="tinyButton danger" data-deliverable-delete="${editing.id}" data-deliverable-delete-project="${project.id}" data-deliverable-tasks="${total}">Eliminar entregable</button>` : ""}
            </div>
            ${editing && total ? `<p class="helperText">Al eliminarlo, sus ${total} ${total === 1 ? "tarea queda" : "tareas quedan"} sin entregable. No se borra ninguna tarea.</p>` : ""}
          </div>`;
      }

      // Chip del entregable en la tarjeta. SOLO si la solicitud tiene
      // entregables (decisión del usuario 2026-07-31): en una solicitud de 3
      // tareas sin agrupar sería una línea de ruido en cada tarjeta.
      function renderTaskDeliverableTag(task) {
        const project = (state.workspace?.projects || []).find((p) => p.id === task.projectId);
        if (!deliverablesOf(project).length) return "";
        const name = deliverableName(project, task.deliverableId);
        return `<span class="entTag ${name ? "" : "entTag--none"}">${escapeHtml(name || "Sin entregable")}</span>`;
      }

      // Selector de entregable en el formulario de la tarea. Como el chip: solo
      // aparece si la solicitud tiene entregables — si no, no hay nada que elegir.
      function renderTaskDeliverableField(task) {
        const project = (state.workspace?.projects || []).find((p) => p.id === task.projectId);
        const items = deliverablesOf(project);
        if (!items.length) return "";
        return `
          <label>Entregable
            <select name="deliverableId">
              <option value="">Sin entregable</option>
              ${items.map((d) => `<option value="${d.id}" ${d.id === task.deliverableId ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("")}
            </select>
          </label>`;
      }

      function renderTaskColumn(status, project, peopleById) {
        const tasks = boardTasks(project).filter((task) => task.status === status.key);
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
        const updatesCount = (task.updates || []).length;
        return `
          <article class="taskCard ${isSelected ? "selected" : ""}" draggable="true" data-task-id="${task.id}" data-task-select="${task.id}">
            <div class="cardHeader">
              <strong>${escapeHtml(task.title)}</strong>
              ${renderEditIconButton("Editar tarea", `data-detail-task="${task.id}" data-detail-task-project="${task.projectId}"`)}
            </div>
            <!-- TARJETA COMPACTA (2026-07-31): entregable, prioridad, responsable
                 y fechas iban en TRES renglones propios; con 15 tareas el tablero
                 medía 1.324px (1,5 pantallas). Ahora comparten una sola fila que
                 envuelve sola cuando no cabe. -->
            <div class="taskMeta">
              ${renderTaskDeliverableTag(task)}
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
              ${renderAssigneeIconButton(task, !!assignee)}
              ${renderTaskDates(task)}
            </div>
            ${renderTaskProgressBar(task)}
            <!-- El «Arrastra para cambiar estado» se repetía en CADA tarjeta: 15
                 veces en la solicitud más grande, ~300px de puro texto igual. Una
                 instrucción se lee UNA vez — ahora va sola arriba del tablero.
                 Aquí queda solo lo que es de ESTA tarea. -->
            ${updatesCount ? `<small>${updatesCount} seguimiento${updatesCount === 1 ? "" : "s"}</small>` : ""}
          </article>
        `;
      }

      // Responsable: botón-ícono (antes era un botón con texto "Asignar/Cambiar"
      // que competía visualmente con el título y el chip en una tarjeta ya densa).
      // Sigue la convención de la app —lápiz=editar, papelera=borrar— sumando
      // persona=responsable, siempre con tooltip + aria-label. El ícono cambia
      // según el caso: persona+ para asignar (invita a llenar un vacío), persona
      // sola para cambiar (el chip de al lado ya dice quién es).
      function renderAssigneeIconButton(task, hasAssignee) {
        const label = hasAssignee ? "Cambiar responsable" : "Asignar responsable";
        const icon = hasAssignee
          ? `<circle cx="12" cy="8" r="3.4"></circle><path d="M5.5 19.5c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5"></path>`
          : `<circle cx="10" cy="8" r="3.4"></circle><path d="M3.5 19.5c0-3.3 2.9-5.5 6.5-5.5 1 0 1.9.2 2.7.5"></path><path d="M17.5 14v6"></path><path d="M14.5 17h6"></path>`;
        return `
          <button class="iconTinyButton iconTinyButton--onCard" type="button"
            data-detail-task="${task.id}" data-detail-task-project="${task.projectId}"
            data-focus-task-assignee="true"
            aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon}</svg>
          </button>`;
      }

      // Fechas en la tarjeta: se muestran solo si existen. La de fin avisa cuando
      // ya venció y la tarea NO está completada (es la señal que se busca en un
      // tablero); una tarea cerrada nunca se pinta como vencida.
      function renderTaskDates(task) {
        const start = task.startDate || "";
        const end = task.endDate || "";
        if (!start && !end) return "";
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Guatemala" });
        const overdue = end && end < today && task.status !== "done";
        const bits = [];
        if (start) bits.push(`<span title="Fecha de inicio">▶ ${escapeHtml(shortDate(start))}</span>`);
        if (end) bits.push(`<span class="${overdue ? "taskDateOverdue" : ""}" title="${overdue ? "Venció y sigue abierta" : "Fecha de fin"}">⏹ ${escapeHtml(shortDate(end))}</span>`);
        return `<div class="taskDates">${bits.join("")}</div>`;
      }

      // "2026-07-31" → "31 jul" (en la tarjeta el año sobra salvo que sea otro).
      function shortDate(iso) {
        const d = new Date(`${iso}T12:00:00`);
        if (isNaN(d.getTime())) return iso;
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return d.toLocaleDateString("es-GT", sameYear
          ? { day: "numeric", month: "short" }
          : { day: "numeric", month: "short", year: "numeric" });
      }

      // Barra de avance de la tarjeta: el % manual se marca con tono propio (dato
      // afirmado por el responsable) y el derivado del estado queda tenue.
      function renderTaskProgressBar(task) {
        const { pct, source } = taskProgress(task);
        return `
          <div class="taskProgress ${source === "manual" ? "manual" : "derived"}" title="${source === "manual" ? "Avance registrado por el responsable" : "Derivado del estado de la tarea"}">
            <div class="taskProgressTrack"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>
            <span class="taskProgressPct">${pct}%</span>
          </div>`;
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
              ${renderAreaField("areaId", "Área", person.areaId)}
              <label>Estado
                <select name="status">
                  <option value="" ${person.status ? "" : "selected"}>Ninguno</option>
                  ${(state.workspace?.personStatuses || [{ key: "active", label: "Activo" }, { key: "inactive", label: "Inactivo" }]).map((st) => `<option value="${st.key}" ${person.status === st.key ? "selected" : ""}>${escapeHtml(st.label)}</option>`).join("")}
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
                  ${requestTypes().map((t) => `<option value="${t.key}" ${project.requestType === t.key ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("")}
                </select>
              </label>
              ${renderAreaField("requestingAreaId", "Área solicitante", project.requestingAreaId)}
              ${renderAreaField("targetAreaId", "Grupo de trabajo", project.targetAreaId)}
              <label>Estado
                <div class="fieldWithActions">
                  <select name="status" data-status-select>
                    ${projectStatusOptions(project.status)}
                  </select>
                  ${canManageCatalogs() ? renderEditIconButton("Corregir o eliminar el estado", "data-status-fix hidden") : ""}
                </div>
              </label>
              ${canManageCatalogs() ? `
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
              </div>` : ""}
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

      // Bitácora POR TAREA (2026-07-24): misma mecánica que la de la solicitud
      // (fecha de hoy automática, edición de texto/fecha, borrado), en el panel
      // de detalle de la tarea. Las entradas también alimentan la búsqueda
      // avanzada: el acierto lleva a la solicitud padre.
      function renderTaskUpdateRow(task, u, editing) {
        if (editing && editing.taskId === task.id && editing.updateId === u.id) {
          return `
            <form class="projectUpdateRow projectUpdateEditForm" data-task-update-edit-form="${task.id}" data-task-update-project="${task.projectId}" data-update-id="${u.id}">
              <input class="projectUpdateDateInput" name="date" type="date" value="${escapeAttribute(u.date)}" required aria-label="Fecha del seguimiento" />
              <input class="projectUpdateTextInput" name="text" type="text" value="${escapeAttribute(u.text)}" required aria-label="Texto del seguimiento" />
              <div class="projectUpdateEditActions">
                <button class="tinyButton" type="submit">Guardar</button>
                <button class="tinyButton ghost" type="button" data-task-update-cancel>Cancelar</button>
                <button class="tinyButton danger" type="button" data-task-update-delete="${task.id}" data-task-update-project="${task.projectId}" data-update-id="${u.id}">Eliminar</button>
              </div>
            </form>`;
        }
        const author = u.createdByName || u.createdBy || "";
        const time = updateTimeLabel(u.createdAt);
        const meta = [
          time ? `<span class="projectUpdateTime">${escapeHtml(time)}</span>` : "",
          author ? `<span class="projectUpdateAuthor" title="Registrado por ${escapeAttribute(author)}">${escapeHtml(author)}</span>` : ""
        ].filter(Boolean).join(" · ");
        return `
          <div class="projectUpdateRow">
            <div class="projectUpdateBody">
              ${meta ? `<span class="projectUpdateMeta">${meta}</span>` : ""}
              <span class="projectUpdateText">${escapeHtml(u.text)}</span>
            </div>
            ${renderEditIconButton("Editar seguimiento", `data-task-update-edit="${task.id}" data-task-update-project="${task.projectId}" data-update-id="${u.id}"`)}
          </div>`;
      }

      function renderTaskUpdates(task) {
        const updates = task.updates || [];
        const expanded = !!state.taskUpdatesExpanded[task.id];
        const visible = expanded ? updates : updates.slice(0, 3);
        const editing = state.taskUpdateEditing;
        const groups = [];
        for (const u of visible) {
          const last = groups[groups.length - 1];
          if (last && last.date === u.date) last.items.push(u);
          else groups.push({ date: u.date, items: [u] });
        }
        const rows = groups.map((g) => `
          <div class="projectUpdateDay">
            <div class="projectUpdateDayHeader">${escapeHtml(updateDateLabel(g.date))}</div>
            ${g.items.map((u) => renderTaskUpdateRow(task, u, editing)).join("")}
          </div>`).join("");
        return `
          <section class="projectUpdatesBlock taskUpdatesBlock">
            ${blockHeaderHtml("seguimiento", "Seguimiento de la tarea", updates.length)}
            <form class="inlineForm taskUpdateForm" data-task-update-quick="${task.id}" data-task-update-project="${task.projectId}">
              <textarea name="text" class="taskUpdateInput" rows="2" title="Enter registra · Shift+Enter salta de línea" placeholder="¿Qué se avanzó en esta tarea? Se registra con la fecha de hoy" required maxlength="2000"></textarea>
              <div class="taskUpdateFormActions">
                <span class="taskUpdateHint" title="Shift+Enter salta de línea">Enter registra</span>
                <button class="primaryButton" type="submit">Registrar</button>
              </div>
            </form>
            <div class="projectUpdateList">
              ${rows || `<p class="emptyText">Sin registros aún. Anota el avance de esta tarea.</p>`}
            </div>
            ${updates.length > 3 ? `<button class="tinyButton ghost projectUpdateToggle" type="button" data-task-update-toggle="${task.id}">${expanded ? "Ver menos" : `Ver todas (${updates.length})`}</button>` : ""}
          </section>`;
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
              ${renderTaskDeliverableField(task)}
              <div class="taskDatesRow">
                <label>Fecha de inicio<input name="startDate" type="date" value="${escapeAttribute(task.startDate || "")}" /></label>
                <label>Fecha de fin<input name="endDate" type="date" value="${escapeAttribute(task.endDate || "")}" /></label>
              </div>
              <label>% de avance
                <input name="progress" type="number" min="0" max="100" step="5" inputmode="numeric" placeholder="—" value="${task.progress === "" || task.progress === undefined || task.progress === null ? "" : escapeAttribute(String(task.progress))}" />
              </label>
              <p class="fieldHint">${task.progress === "" || task.progress === undefined || task.progress === null
                ? `Vacío = se deriva del estado (${taskProgress(task).pct}%). Escribe un % para reflejar el avance real de una tarea a medias.`
                : `Avance registrado por el responsable. Si lo dejas vacío, se deriva del estado.`}</p>
              <label>Notas<textarea name="notes" rows="4">${escapeHtml(task.notes)}</textarea></label>
              <button class="primaryButton" type="submit">Guardar tarea</button>
              ${notice ? `<p class="saveFeedback" role="status">${escapeHtml(notice)}</p>` : ""}
            </form>
            ${renderTaskUpdates(task)}
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
        if (canManageCatalogs()) {
          opts.push(`<option value="__new__">+ Agregar estado…</option>`);
        }
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

      // Handlers de la LISTA de solicitudes (tabla Gestión + tablero) acotados a un
      // `scope`. Se usan en el bind completo (scope=document) y en el re-render
      // parcial de la búsqueda (scope = solo el contenedor de la lista): así el
      // buscador NO destruye su propio input al filtrar (en móvil eso cerraba el
      // teclado en cada tecla). Al acotar el scope no se duplican listeners.
      function bindProjectListHandlers(scope) {
        for (const th of scope.querySelectorAll("[data-proj-sort]")) {
          th.addEventListener("click", () => {
            const key = th.dataset.projSort;
            state.projectSort = (state.projectSort?.key === key)
              ? { key, dir: state.projectSort.dir * -1 }
              : { key, dir: 1 };
            renderWorkspace();
          });
        }
        // Fila de la tabla → selecciona y muestra el detalle abajo. Clic normal =
        // seleccionar + peek; clic en el chevron › = ir de lleno al detalle.
        for (const row of scope.querySelectorAll("[data-project-row]")) {
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
        // Tablero de avance: fila expande "¿Qué falta? / ¿Cuándo?".
        for (const row of scope.querySelectorAll("[data-board-toggle]")) {
          row.addEventListener("click", () => {
            const id = row.dataset.boardToggle;
            state.boardExpanded = state.boardExpanded === id ? null : id;
            renderWorkspace();
          });
        }
        // Soltar una persona sobre una solicitud (drag & drop, atajo).
        for (const project of scope.querySelectorAll("[data-project-id]")) {
          project.addEventListener("dragover", allowDrop);
          project.addEventListener("drop", dropOnProject);
        }
      }

      // Re-render SOLO de la lista + contador (sin tocar el buscador → el input
      // sobrevive y en móvil el teclado no se cierra). Mismo patrón que Catálogo/
      // Facturación/Athena (docs/06; regla "filtrar sin re-render para no perder foco").
      function applyProjectSearch() {
        persistPrefs();     // ruta de repintado PARCIAL: no pasa por renderWorkspace
        const workspace = state.workspace;
        if (!workspace) return;
        const panel = elements.contentPanel;
        const listWrap = panel.querySelector(".projectTableWrap") || panel.querySelector(".projectBoardWrap");
        if (!listWrap) { renderWorkspace(); return; }  // vista sin lista → render normal
        const peopleById = Object.fromEntries(workspace.people.map((p) => [p.id, p]));
        const visibleProjects = getVisibleProjects(workspace.projects, peopleById);
        const isBoard = (state.workspaceView || "manage") === "board";
        // El activo NO se reasigna al teclear (evita que el detalle salte); solo
        // se usa para resaltar la fila si sigue visible.
        const activeProject = visibleProjects.find((p) => p.id === state.activeProjectId)
          || workspace.projects.find((p) => p.id === state.activeProjectId) || null;
        listWrap.innerHTML = isBoard
          ? renderProgressBoard(visibleProjects, peopleById)
          : projectTableContent(visibleProjects, activeProject, peopleById);
        const pill = panel.querySelector(".projectTableHead .countPill");
        if (pill) pill.textContent = `${visibleProjects.length} de ${workspace.projects.length} solicitudes`;
        bindProjectListHandlers(listWrap);
      }

      // Búsqueda AVANZADA (semántica) de solicitudes: por ENVÍO. Llama al backend
      // (embebe la consulta con Titan, híbrida sobre solicitud + seguimiento),
      // guarda projectId → {score, via, updateId} y re-renderiza: la MISMA tabla se
      // reordena por relevancia y se filtra a las coincidencias (combinando con los
      // filtros de estado/área). Es un envío discreto (no por tecla), así que un
      // renderWorkspace() completo aquí no tiene el problema de foco del keyword.
      function resetProjectSem() {
        state.projectSemResults = {}; state.projectSemQuery = "";
        state.projectSemFilters = {}; state.projectSemConcept = "";
        state.projectSemInterpretation = ""; state.projectSemError = "";
      }

      async function runProjectSemanticSearch() {
        const q = (state.projectSearch || "").trim();
        if (!q) { resetProjectSem(); renderWorkspace(); return; }
        state.projectSemLoading = true; state.projectSemError = "";
        renderWorkspace();
        try {
          const payload = await apiRequest(`api/workspace/search?q=${encodeURIComponent(q)}`);
          const d = payload.data || {};
          const map = {};
          for (const r of (d.results || [])) map[r.projectId] = r;
          state.projectSemResults = map;
          state.projectSemFilters = d.filters || {};
          state.projectSemConcept = d.semantic || "";
          state.projectSemInterpretation = d.interpretation || "";
          state.projectSemQuery = q;
          state.projectSemError = "";
        } catch (err) {
          state.projectSemResults = {}; state.projectSemFilters = {}; state.projectSemConcept = "";
          state.projectSemInterpretation = ""; state.projectSemQuery = q;
          state.projectSemError = err?.message || "No se pudo completar la búsqueda.";
        }
        state.projectSemLoading = false;
        renderWorkspace();
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

        // "Fecha de solicitud" manda sobre "Fecha de entrega": al elegirla, la
        // entrega se precarga con esa fecha (su calendario abre ahí, no en hoy)
        // y no permite anteriores — mismo patrón que Desde/Hasta en Personal.
        if (projectDetailForm) {
          const reqDate = projectDetailForm.querySelector("input[name='requestDate']");
          const dueDate = projectDetailForm.querySelector("input[name='dueDate']");
          if (reqDate && dueDate) {
            if (reqDate.value) dueDate.min = reqDate.value;
            reqDate.addEventListener("change", () => {
              if (!reqDate.value) { dueDate.removeAttribute("min"); return; }
              dueDate.min = reqDate.value;
              if (!dueDate.value || dueDate.value < reqDate.value) dueDate.value = reqDate.value;
            });
          }
        }

        personForm?.addEventListener("submit", submitPersonForm);
        projectForm?.addEventListener("submit", submitProjectForm);
        // Keyword: filtra SIN re-render del módulo (solo lista + contador, dejando
        // vivo el input → en móvil el teclado no se cierra; regla docs/06).
        // Avanzada (semántica): por ENVÍO explícito (Enter/botón), NO en cada tecla
        // — se escribe la idea completa; buscar con frases a medias confunde.
        projectSearch?.addEventListener("input", (event) => {
          state.projectSearch = event.target.value;
          // OJO: guardar aquí, PEGADO a la mutación. Este input usa repintado
          // PARCIAL (applyProjectSearch, para no cerrar el teclado en móvil) y
          // por eso no pasa por renderWorkspace: confiar solo en el render dejaba
          // la búsqueda sin persistir — el único campo que el usuario notó.
          persistPrefs();
          if (state.projectAdvanced) {
            if (!(state.projectSearch || "").trim()) { resetProjectSem(); renderWorkspace(); }
          } else {
            applyProjectSearch();
          }
        });
        projectSearch?.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && state.projectAdvanced) { event.preventDefault(); runProjectSemanticSearch(); }
        });
        document.querySelector("#projectSemGoBtn")?.addEventListener("click", runProjectSemanticSearch);
        document.querySelector("#projectAdvancedToggle")?.addEventListener("click", () => {
          state.projectAdvanced = !state.projectAdvanced;
          state.projectSemError = "";
          if (!state.projectAdvanced) resetProjectSem();
          renderWorkspace();
          if (state.projectAdvanced && (state.projectSearch || "").trim()) runProjectSemanticSearch();
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

        // Seguimiento POR TAREA (mismos gestos que el de la solicitud).
        for (const form of document.querySelectorAll("[data-task-update-quick]")) {
          form.addEventListener("submit", submitTaskUpdateForm);
          // El campo es un textarea (el panel de detalle es angosto y una sola
          // línea escondía lo escrito): crece con el contenido y Enter registra
          // —Shift+Enter hace salto de línea— para no perder el gesto de siempre.
          const ta = form.querySelector(".taskUpdateInput");
          if (!ta) continue;
          const autoGrow = () => {
            ta.style.height = "auto";
            ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
          };
          ta.addEventListener("input", autoGrow);
          ta.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              form.requestSubmit();
            }
          });
          autoGrow();
        }
        for (const form of document.querySelectorAll("[data-task-update-edit-form]")) {
          form.addEventListener("submit", submitTaskUpdateEditForm);
        }
        for (const button of document.querySelectorAll("[data-task-update-edit]")) {
          button.addEventListener("click", () => {
            state.taskUpdateEditing = { taskId: button.dataset.taskUpdateEdit, updateId: button.dataset.updateId };
            renderWorkspace();
          });
        }
        for (const button of document.querySelectorAll("[data-task-update-cancel]")) {
          button.addEventListener("click", () => {
            state.taskUpdateEditing = null;
            renderWorkspace();
          });
        }
        for (const button of document.querySelectorAll("[data-task-update-delete]")) {
          button.addEventListener("click", () => deleteTaskUpdate(
            button.dataset.taskUpdateProject, button.dataset.taskUpdateDelete, button.dataset.updateId));
        }
        for (const button of document.querySelectorAll("[data-task-update-toggle]")) {
          button.addEventListener("click", () => {
            const id = button.dataset.taskUpdateToggle;
            state.taskUpdatesExpanded[id] = !state.taskUpdatesExpanded[id];
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
          zone.addEventListener("drop", async (event) => {
            event.preventDefault();
            zone.classList.remove("dragging");
            // Si lo soltado incluye CARPETAS hay que recorrerlas: dataTransfer.files
            // entrega la carpeta como un archivo de 0 bytes (bug 2026-07-31).
            const entradas = await entradasDeArrastre(event.dataTransfer);
            if (entradas) {
              if (entradas.length) uploadFolder(projectId, entradas);
              else alert("La carpeta que soltaste está vacía.");
              return;
            }
            uploadAttachments(projectId, [...(event.dataTransfer?.files || [])], "");
          });
          zone.addEventListener("paste", (event) => {
            const files = [...(event.clipboardData?.files || [])];
            if (files.length) { event.preventDefault(); uploadAttachments(projectId, files, ""); }
          });
        }
        // "+ Query": abrir/cerrar el formulario de texto.
        // ── Árbol de adjuntos: buscador, plegado y selección ─────────────────
        const buscador = document.querySelector("[data-attach-search]");
        if (buscador) {
          buscador.addEventListener("input", (event) => {
            state.attachSearch = event.target.value;
            // Repintado PARCIAL: re-renderizar todo perdería el foco y el
            // cursor del campo (misma trampa que el buscador de solicitudes).
            repintarArbol();
          });
        }
        // Repinta SOLO el árbol. Al desplegar una carpeta, `renderWorkspace()`
        // reconstruía todo el módulo y el contenedor nacía con scrollTop 0: si la
        // carpeta estaba abajo, la vista saltaba al inicio y había que volver a
        // bajar para ver lo que se acababa de abrir (reportado 2026-08-04).
        // Aquí el contenedor SOBREVIVE —solo cambia su contenido— así que
        // conserva su posición. Además evita repintar tareas y seguimiento por
        // un clic que no los toca.
        function repintarArbol() {
          const proyecto = (state.workspace?.projects || [])
            .find((p) => p.id === state.activeProjectId);
          const cont = document.querySelector(".attachTree");
          if (!proyecto || !cont) { renderWorkspace(); return; }
          const atts = attachmentsOf(proyecto.id) || [];
          const q = (state.attachSearch || "").trim().toLowerCase();
          cont.innerHTML = atts.length ? renderAttachTree(proyecto, atts, q) : "";
          bindAttachTree();
        }
        function bindAttachTree() {
          for (const b of document.querySelectorAll("[data-attach-folder]")) {
            b.addEventListener("click", () => {
              const clave = b.dataset.attachFolder;
              const actual = state.attachTreeOpen[clave];
              state.attachTreeOpen[clave] = actual === undefined ? false : !actual;
              repintarArbol();          // conserva el scroll: ver repintarArbol()
            });
          }
          for (const b of document.querySelectorAll("[data-attach-check]")) {
            b.addEventListener("click", () => {
              const id = b.dataset.attachCheck;
              if (state.attachSelected[id]) delete state.attachSelected[id];
              else state.attachSelected[id] = true;
              renderWorkspace();
            });
          }
          for (const b of document.querySelectorAll("[data-attach-check-folder]")) {
            b.addEventListener("click", () => {
              const ruta = b.dataset.attachCheckFolder;
              const atts = (attachmentsOf(b.dataset.attachCheckProject) || [])
                .filter((a) => (a.path || "") === ruta || (a.path || "").startsWith(`${ruta}/`));
              const todas = atts.every((a) => state.attachSelected[a.id]);
              for (const a of atts) {
                if (todas) delete state.attachSelected[a.id];
                else state.attachSelected[a.id] = true;
              }
              renderWorkspace();
            });
          }
        }
        bindAttachTree();
        document.querySelector("[data-attach-unselect]")?.addEventListener("click", () => {
          state.attachSelected = {};
          renderWorkspace();
        });
        for (const sel of document.querySelectorAll("[data-attach-relate-folder]")) {
          sel.addEventListener("change", async () => {
            const ruta = sel.dataset.attachRelateFolder;
            const projectId = sel.dataset.attachRelateProject;
            const n = Number(sel.dataset.attachRelateCount || 0);
            const updateId = sel.value === "__varios__" ? null : sel.value;
            if (updateId === null) return;
            const destino = sel.options[sel.selectedIndex].textContent.trim();
            if (!window.confirm(`¿Relacionar los ${n} archivos de «${ruta}» con ${
              updateId ? `el seguimiento «${destino}»` : "General"}?`)) {
              renderWorkspace();     // devuelve el selector a su valor anterior
              return;
            }
            sel.disabled = true;
            try {
              await apiRequest(`api/projects/${projectId}/attachments/relate-folder`, {
                method: "POST", body: JSON.stringify({ path: ruta, updateId }),
              });
              // Se refresca la lista: la relación cambió en N archivos a la vez.
              delete state.projectAttachments[projectId];
              await loadAttachments(projectId);
            } catch (error) {
              sel.disabled = false;
              alert(error.message);
            }
          });
        }
        document.querySelector("[data-attach-progress-close]")?.addEventListener("click", () => {
          state.attachProgress = null;
          renderWorkspace();
        });
        for (const input of document.querySelectorAll("[data-attach-folder-input]")) {
          input.addEventListener("change", () => {
            const entradas = [...(input.files || [])].map((file) => ({
              file,
              // webkitRelativePath = "Carpeta/Sub/archivo.pdf": se descarta el
              // nombre y queda SOLO la ruta de carpetas.
              path: (file.webkitRelativePath || file.name).split("/").slice(0, -1).join("/"),
            }));
            input.value = "";                       // permite re-subir la misma carpeta
            uploadFolder(input.dataset.attachFolderInput, entradas);
          });
        }
        for (const b of document.querySelectorAll("[data-attach-zip]")) {
          b.addEventListener("click", () => descargarZip(b.dataset.attachZip, b));
        }

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
        // Chip de carpeta de la bitácora → esa carpeta, abierta, en Adjuntos.
        for (const button of document.querySelectorAll("[data-attach-goto-folder]")) {
          button.addEventListener("click", () => irACarpetaAdjuntos(button.dataset.attachGotoFolder));
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

        // Línea de tiempo: modal encima de la vista actual (no otra pestaña — la
        // sesión vive en sessionStorage, que es por pestaña).
        for (const button of document.querySelectorAll("[data-timeline-project]")) {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            const project = findProject(button.dataset.timelineProject);
            if (project) {
              timelineModule.open(project, Object.fromEntries(
                (state.workspace?.people || []).map((p) => [p.id, p])));
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

        // ── Entregables ──────────────────────────────────────────────────────
        // Enfocar uno filtra el tablero de ESA solicitud; volver a pulsarlo (o
        // «Ver todas las tareas») quita el enfoque. Al abrir el tablero se
        // asegura que se vea el efecto del filtro.
        for (const button of document.querySelectorAll("[data-deliverable]")) {
          button.addEventListener("click", () => {
            const id = button.dataset.deliverable;
            state.deliverableFilter = state.deliverableFilter === id ? "" : id;
            state.expandedBoardProjectId = button.dataset.deliverableProject;
            state.activeProjectId = button.dataset.deliverableProject;
            renderWorkspace();
          });
        }
        for (const button of document.querySelectorAll("[data-deliverable-clear]")) {
          button.addEventListener("click", () => {
            state.deliverableFilter = "";
            renderWorkspace();
          });
        }
        // «+ Entregable» vive en el bloque Tareas, pero el formulario se dibuja
        // con la franja, ARRIBA DEL TABLERO — a media pantalla de distancia. Sin
        // llevar la vista hasta ahí, pulsarlo parece no hacer nada (fue justo lo
        // que reportó el usuario el 2026-07-31: "no encuentro ese botón").
        function abrirFormEntregable(projectId, deliverableId) {
          state.deliverableFormProject = projectId;
          state.deliverableEditing = deliverableId || null;
          renderWorkspace();
          const panel = document.querySelector(`[data-deliverables-project="${projectId}"]`);
          if (!panel) return;
          const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          panel.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
          panel.querySelector("[data-deliverable-name]")?.focus({ preventScroll: true });
          // Destello del panel para dirigir la mirada: misma convención que al
          // abrir el detalle de una solicitud (docs/06 #2).
          if (!reduce && panel.animate) {
            panel.animate([
              { boxShadow: "0 0 0 0 rgba(15, 118, 110, 0)" },
              { boxShadow: "0 0 0 3px rgba(15, 118, 110, 0.45)", offset: 0.25 },
              { boxShadow: "0 0 0 0 rgba(15, 118, 110, 0)" },
            ], { duration: 900, easing: "ease-out" });
          }
        }
        for (const button of document.querySelectorAll("[data-deliverable-new]")) {
          button.addEventListener("click", () => abrirFormEntregable(button.dataset.deliverableNew, null));
        }
        for (const button of document.querySelectorAll("[data-deliverable-edit]")) {
          button.addEventListener("click", () =>
            abrirFormEntregable(button.dataset.deliverableEditProject, button.dataset.deliverableEdit));
        }
        for (const button of document.querySelectorAll("[data-deliverable-cancel]")) {
          button.addEventListener("click", () => {
            state.deliverableFormProject = null;
            state.deliverableEditing = null;
            renderWorkspace();
          });
        }
        for (const button of document.querySelectorAll("[data-deliverable-save]")) {
          button.addEventListener("click", async () => {
            const projectId = button.dataset.deliverableSave;
            const name = (document.querySelector("[data-deliverable-name]")?.value || "").trim();
            const dueDate = document.querySelector("[data-deliverable-date]")?.value || "";
            if (!name) {
              document.querySelector("[data-deliverable-name]")?.focus();
              return;
            }
            const editing = state.deliverableEditing;
            button.disabled = true;
            button.textContent = "Guardando…";
            try {
              const path = editing
                ? `api/projects/${projectId}/deliverables/${editing}`
                : `api/projects/${projectId}/deliverables`;
              await apiRequest(path, {
                method: editing ? "PATCH" : "POST",
                body: JSON.stringify({ name, dueDate }),
              });
              // El estado se cierra ANTES de refrescar: refreshWorkspace ya
              // repinta al final, así se pinta una sola vez y sin el formulario.
              state.deliverableFormProject = null;
              state.deliverableEditing = null;
              await refreshWorkspace();
            } catch (error) {
              button.disabled = false;
              button.textContent = editing ? "Guardar" : "Crear entregable";
              alert(error.message);
            }
          });
        }
        for (const button of document.querySelectorAll("[data-deliverable-delete]")) {
          button.addEventListener("click", async () => {
            const projectId = button.dataset.deliverableDeleteProject;
            const id = button.dataset.deliverableDelete;
            const n = Number(button.dataset.deliverableTasks || 0);
            const aviso = n
              ? `¿Eliminar el entregable? Sus ${n} ${n === 1 ? "tarea quedará" : "tareas quedarán"} sin entregable (no se borra ninguna tarea).`
              : "¿Eliminar el entregable?";
            if (!window.confirm(aviso)) return;
            try {
              await apiRequest(`api/projects/${projectId}/deliverables/${id}`, { method: "DELETE" });
              if (state.deliverableFilter === id) state.deliverableFilter = "";
              state.deliverableFormProject = null;
              state.deliverableEditing = null;
              await refreshWorkspace();
            } catch (error) {
              alert(error.message);
            }
          });
        }

        for (const button of document.querySelectorAll("[data-project-status-filter]")) {
          button.addEventListener("click", () => {
            const value = button.dataset.projectStatusFilter || "all";
            const full = allStatusIds();
            const on = selectedStatusIds();
            if (value === "all") {
              // Maestro: si están todos, los apaga; si falta alguno, los enciende.
              state.projectStatusFilter = on.length === full.length ? [NO_STATUS_SELECTED] : [];
            } else {
              const next = on.includes(value)
                ? on.filter((s) => s !== value)
                : [...on, value];
              // Se guarda en forma canónica para que el resto del módulo (filtro,
              // «Limpiar», prefs guardadas) siga leyendo [] como "sin filtro".
              state.projectStatusFilter = next.length === full.length
                ? []
                : (next.length ? next : [NO_STATUS_SELECTED]);
            }
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
        const reportBtn = document.querySelector("#wsReportBtn");
        if (reportBtn) reportBtn.addEventListener("click", openReportModal);
        // Tablero: expandir/colapsar el "¿Qué falta? / ¿Cuándo?" de una solicitud.
        // Handlers de la lista (tabla + tablero + drop en solicitud), en un solo
        // lugar reutilizado por la búsqueda parcial.
        bindProjectListHandlers(document);

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
          state.projectStatusFilter = [];
          state.projectTypeFilter = "all";
          state.projectAreaFilter = "all";
          state.projectTargetAreaFilter = "all";
          state.projectOwnerFilter = "all";
          state.projectInvolvesFilter = "all";
          state.projectSearch = "";
          renderWorkspace();
        });

        // Crear solicitud: colapsado por defecto (separa "crear" de "buscar").
        document.querySelector("#projectCreateToggle")?.addEventListener("click", () => {
          state.showProjectForm = !state.showProjectForm;
          renderWorkspace();
          if (state.showProjectForm) {
            requestAnimationFrame(() =>
              document.querySelector("#projectQuickForm input[name='name']")?.focus());
          }
        });

        // ── Orden manual de filas ─────────────────────────────────────────────
        document.querySelector("#projectManualOrderBtn")?.addEventListener("click", () => {
          state.projectManualOrder = !state.projectManualOrder;
          if (state.projectManualOrder) {
            state.projectSort = null;      // manual y orden por columna se excluyen
            // Primera vez: se toma el orden que el usuario TIENE en pantalla como
            // punto de partida (nada se mueve al encender el modo).
            if (!(state.projectRowOrder || []).length) {
              state.projectRowOrder = [...(state._projectVisibleIds || [])];
            }
          }
          saveTablePrefs();
          renderWorkspace();
        });
        for (const button of document.querySelectorAll("[data-project-move-up]")) {
          button.addEventListener("click", (event) => {
            event.stopPropagation();       // no seleccionar la fila al mover
            moveProjectRow(button.dataset.projectMoveUp, -1, state._projectVisibleIds);
          });
        }
        for (const button of document.querySelectorAll("[data-project-move-down]")) {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            moveProjectRow(button.dataset.projectMoveDown, 1, state._projectVisibleIds);
          });
        }
        // Arrastre desde el asa (no la fila entera: la fila ya es zona de soltado
        // para personas/tareas y clic para abrir el detalle).
        for (const handle of document.querySelectorAll("[data-project-drag]")) {
          handle.addEventListener("dragstart", (event) => {
            event.dataTransfer.setData("text/plain", `projectRow:${handle.dataset.projectDrag}`);
            event.dataTransfer.effectAllowed = "move";
            handle.closest("tr")?.classList.add("dragging");
          });
          handle.addEventListener("dragend", () => {
            handle.closest("tr")?.classList.remove("dragging");
          });
        }
        if (state.projectManualOrder) {
          for (const row of document.querySelectorAll("[data-project-row]")) {
            row.addEventListener("dragover", (event) => {
              const raw = event.dataTransfer.getData("text/plain") || "";
              // En dragover el dato puede no estar disponible en algunos
              // navegadores: se permite igual y se valida al soltar.
              if (raw && !raw.startsWith("projectRow:")) return;
              event.preventDefault();
              row.classList.add("dropTarget");
            });
            row.addEventListener("dragleave", () => row.classList.remove("dropTarget"));
            row.addEventListener("drop", (event) => {
              row.classList.remove("dropTarget");
              const raw = event.dataTransfer.getData("text/plain") || "";
              if (!raw.startsWith("projectRow:")) return;   // otro arrastre (persona/tarea)
              event.preventDefault();
              event.stopPropagation();
              dropProjectRow(raw.slice("projectRow:".length), row.dataset.projectRow,
                             state._projectVisibleIds);
            });
          }
        }

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

        // (orden de columnas y clic de fila → bindProjectListHandlers, arriba)

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
          // Sin permiso de catálogo el campo se pinta sin formulario: no hay nada
          // que cablear (mismo criterio que el bloque de Estado, más abajo).
          if (!areaForm) continue;
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

        // Empty state guiado: lleva el foco al formulario de crear proyecto.
        const emptyCta = document.querySelector("#emptyCreateFocus");
        if (emptyCta) emptyCta.addEventListener("click", () => {
          // El formulario ahora está colapsado: hay que ABRIRLO y luego enfocar.
          state.showProjectForm = true;
          renderWorkspace();
          requestAnimationFrame(() =>
            document.querySelector("#projectQuickForm input[name='name']")?.focus());
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

        // (drop de persona en solicitud → bindProjectListHandlers, arriba)
        // Ya NO hay zona de soltar sobre el directorio: al pasar Personas a vista
        // propia (2026-08-04) el panel dejó de convivir con solicitudes y tareas,
        // así que arrastrar una ficha hasta aquí para desasignar es imposible.
        // La vía visible sigue intacta: la × del chip de la persona.

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
            // "Registrar persona nueva…" no es un id: abre el mini-formulario.
            if (select.value === NEW_PERSON_OPTION) {
              state.memberCreateFor = select.dataset.projectMember;
              renderWorkspace();
              document.querySelector("[data-member-create-input]")?.focus({ preventScroll: true });
              return;
            }
            try {
              await addProjectMember(select.dataset.projectMember, select.value);
            } catch (error) {
              alert(error.message);
            }
          });
        }

        for (const box of document.querySelectorAll("[data-member-create]")) {
          const input = box.querySelector("[data-member-create-input]");
          const cerrar = () => { state.memberCreateFor = null; renderWorkspace(); };
          box.querySelector("[data-member-create-cancel]")?.addEventListener("click", cerrar);
          box.querySelector("[data-member-create-save]")?.addEventListener("click",
            () => createPersonAndAssign(box.dataset.memberCreate, input?.value, box));
          // Enter guarda: es un campo único, pedir el clic sería un paso de más.
          input?.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); createPersonAndAssign(box.dataset.memberCreate, input.value, box); }
            if (event.key === "Escape") { event.preventDefault(); cerrar(); }
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
        const values = Object.fromEntries(form.entries());
        // "__new__" es el disparador del mini-formulario de área, no un id.
        if (values.areaId === "__new__") values.areaId = "";
        try {
          await apiRequest("api/people", {
            method: "POST",
            body: JSON.stringify(values)
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
          // Se ANCLA para que ningún filtro ni búsqueda activa la esconda: al
          // crearla no tiene estado, área ni responsable, así que casi cualquier
          // filtro la dejaba fuera y con ella desaparecía su formulario.
          state.pinnedProjectId = payload.data.id;
          state.saveNotice = { target: `project-create:${payload.data.id}`, message: "Solicitud creada." };
          state.showProjectForm = false;      // vuelve al botón: crear es ocasional
          target.reset();
          await refreshWorkspace();
          // Y se LLEVA la vista al formulario recién abierto: crear sirve para
          // seguir llenando los campos, no para volver al listado a buscarla.
          revealProjectDetail(true);
          requestAnimationFrame(() => {
            document.querySelector("#projectDetailForm input[name='name']")?.focus({ preventScroll: true });
          });
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
          const values = Object.fromEntries(form.entries());
          if (values.areaId === "__new__") values.areaId = "";
          await updatePerson(target.dataset.personDetail, values);
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

      // ── Seguimiento por tarea ───────────────────────────────────────────────
      function findTask(projectId, taskId) {
        return (findProject(projectId)?.tasks || []).find((t) => t.id === taskId) || null;
      }

      function sortTaskUpdates(task) {
        task.updates.sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
      }

      async function submitTaskUpdateForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const taskId = target.dataset.taskUpdateQuick;
        const projectId = target.dataset.taskUpdateProject;
        if (!taskId || !projectId) return;
        const text = (new FormData(target).get("text") || "").toString().trim();
        if (!text) return;
        const unlock = lockSubmit(target);
        const ta = target.querySelector(".taskUpdateInput");
        try {
          const payload = await apiRequest(`api/projects/${projectId}/tasks/${taskId}/updates`, {
            method: "POST",
            body: JSON.stringify({ text })
          });
          const task = findTask(projectId, taskId);
          if (task) {
            task.updates = [payload.data, ...(task.updates || [])];
            sortTaskUpdates(task);
          }
          target.reset();
          if (ta) ta.style.height = "";      // vuelve a su alto base tras registrar
          renderWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function submitTaskUpdateEditForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const taskId = target.dataset.taskUpdateEditForm;
        const projectId = target.dataset.taskUpdateProject;
        const updateId = target.dataset.updateId;
        if (!taskId || !projectId || !updateId) return;
        const form = new FormData(target);
        const text = (form.get("text") || "").toString().trim();
        const date = (form.get("date") || "").toString();
        if (!text || !date) return;
        const unlock = lockSubmit(target);
        try {
          const payload = await apiRequest(`api/projects/${projectId}/tasks/${taskId}/updates/${updateId}`, {
            method: "PATCH",
            body: JSON.stringify({ text, date })
          });
          const task = findTask(projectId, taskId);
          if (task) {
            const idx = (task.updates || []).findIndex((item) => item.id === updateId);
            if (idx >= 0) task.updates[idx] = { ...task.updates[idx], ...payload.data };
            sortTaskUpdates(task);
          }
          state.taskUpdateEditing = null;
          renderWorkspace();
        } catch (error) {
          alert(error.message);
        } finally {
          unlock();
        }
      }

      async function deleteTaskUpdate(projectId, taskId, updateId) {
        if (!projectId || !taskId || !updateId) return;
        if (!window.confirm("¿Eliminar esta entrada de seguimiento? No se puede deshacer.")) return;
        try {
          await apiRequest(`api/projects/${projectId}/tasks/${taskId}/updates/${updateId}`, { method: "DELETE" });
          const task = findTask(projectId, taskId);
          if (task) task.updates = (task.updates || []).filter((item) => item.id !== updateId);
          state.taskUpdateEditing = null;
          renderWorkspace();
        } catch (error) {
          alert(error.message);
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
      // ── Descarga en ZIP (2026-07-31) ────────────────────────────────────────
      // El zip se arma EN EL NAVEGADOR: se bajan los archivos con las URLs
      // prefirmadas que ya existen y se comprimen aquí. Hacerlo en el backend
      // significaría que la Lambda descargue todo de S3, comprima y vuelva a
      // subir — el doble de transferencia, tiempo de cómputo por cada descarga
      // y riesgo de timeout. JSZip va AUTO-HOSPEDADO en /vendor/ (regla del
      // proyecto: nada de CDNs externos, hay laptops que solo alcanzan AWS).
      const ZIP_AVISO_BYTES = 200 * 1024 * 1024;
      let zipLoad = null;

      function cargarJSZip() {
        if (window.JSZip) return Promise.resolve(window.JSZip);
        if (!zipLoad) {
          zipLoad = new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "/vendor/jszip.min.js";
            s.onload = () => resolve(window.JSZip);
            s.onerror = () => reject(new Error("No se pudo cargar el compresor."));
            document.head.appendChild(s);
          });
        }
        return zipLoad;
      }

      async function descargarZip(projectId, boton) {
        const todos = attachmentsOf(projectId) || [];
        const sel = todos.filter((a) => state.attachSelected[a.id] && a.kind !== "query");
        if (!sel.length) {
          alert("Selecciona al menos un archivo. Las queries no se incluyen en el zip.");
          return;
        }
        const peso = sel.reduce((s, a) => s + Number(a.size || 0), 0);
        if (peso > ZIP_AVISO_BYTES
            && !window.confirm(`La selección pesa ${pesoLegible(peso)} y se comprime en tu navegador, que puede tardar o quedarse sin memoria. ¿Continuar?`)) {
          return;
        }
        const etiqueta = boton.textContent;
        boton.disabled = true;
        try {
          const JSZipCtor = await cargarJSZip();
          const zip = new JSZipCtor();
          let hechos = 0;
          for (const att of sel) {
            boton.textContent = `Preparando ${++hechos} de ${sel.length}…`;
            const url = await apiRequest(`api/projects/${projectId}/attachments/${att.id}/url`);
            const resp = await fetch(url.data.url);
            if (!resp.ok) throw new Error(`No se pudo bajar ${att.fileName}.`);
            // La ruta se respeta DENTRO del zip: al descomprimir queda el mismo
            // árbol que se ve en pantalla.
            zip.file(att.path ? `${att.path}/${att.fileName}` : att.fileName, await resp.blob());
          }
          boton.textContent = "Comprimiendo…";
          const blob = await zip.generateAsync({ type: "blob" });
          const proyecto = findProject(projectId);
          const nombre = `${(proyecto?.name || "adjuntos").replace(/[^\w\s.-]/g, "").trim().slice(0, 60) || "adjuntos"}.zip`;
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = nombre;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        } catch (error) {
          alert(error.message);
        } finally {
          boton.disabled = false;
          boton.textContent = etiqueta;
        }
      }

      // ── Subida de CARPETA (2026-07-31) ──────────────────────────────────────
      // El navegador entrega la ruta relativa de cada archivo; esa ruta se
      // guarda como campo del adjunto y de ahí sale el árbol. Sube de 4 en 4:
      // en serie 50 archivos se sienten eternos y de golpe se saturan la red y
      // el límite de conexiones del navegador.
      const SUBIDA_EN_PARALELO = 4;
      const MAX_ARCHIVOS_CARPETA = 300;

      // ── Arrastrar una CARPETA (2026-07-31) ──────────────────────────────────
      // Al soltar una carpeta, `dataTransfer.files` NO trae su contenido: entrega
      // la carpeta como un "archivo" de 0 bytes, y por eso salía «El archivo está
      // vacío». Hay que recorrerla con la API de entradas del navegador.
      function recorrerEntrada(entry, prefijo, out) {
        return new Promise((resolve) => {
          if (entry.isFile) {
            entry.file((f) => { out.push({ file: f, path: prefijo }); resolve(); }, () => resolve());
            return;
          }
          if (!entry.isDirectory) return resolve();
          const ruta = prefijo ? `${prefijo}/${entry.name}` : entry.name;
          const reader = entry.createReader();
          // OJO: readEntries devuelve POR TANDAS (máx. 100 por llamada). Hay que
          // llamarlo hasta que devuelva vacío o una carpeta grande se trunca.
          const leerTanda = () => reader.readEntries(async (tanda) => {
            if (!tanda.length) return resolve();
            await Promise.all([...tanda].map((hijo) => recorrerEntrada(hijo, ruta, out)));
            leerTanda();
          }, () => resolve());
          leerTanda();
        });
      }

      // Devuelve [{file, path}] si lo soltado incluye carpetas; null si son
      // archivos sueltos (que siguen por el camino de siempre).
      async function entradasDeArrastre(dataTransfer) {
        const items = [...(dataTransfer?.items || [])];
        const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
        if (!entries.some((e) => e.isDirectory)) return null;
        const out = [];
        await Promise.all(entries.map((e) => recorrerEntrada(e, "", out)));
        return out;
      }

      // `entradas` = [{ file, path }]. El path viene del input (webkitRelativePath)
      // o del recorrido del árbol al ARRASTRAR una carpeta.
      async function uploadFolder(projectId, entradas) {
        const lista = [...entradas];
        if (!lista.length) return;
        if (lista.length > MAX_ARCHIVOS_CARPETA) {
          alert(`La carpeta tiene ${lista.length} archivos y el máximo por carga es ${MAX_ARCHIVOS_CARPETA}. Sube menos carpetas a la vez.`);
          return;
        }
        state.attachProgress = { projectId, hechos: 0, total: lista.length, fallidos: [] };
        renderWorkspace();
        let siguiente = 0;
        const trabajador = async () => {
          while (siguiente < lista.length) {
            const { file, path } = lista[siguiente++];
            try {
              await subirUno(projectId, file, path);
            } catch (error) {
              state.attachProgress.fallidos.push({
                nombre: path ? `${path}/${file.name}` : file.name, motivo: error.message });
            }
            state.attachProgress.hechos += 1;
            pintarProgresoAdjuntos();
          }
        };
        await Promise.all(Array.from({ length: Math.min(SUBIDA_EN_PARALELO, lista.length) }, trabajador));
        const fallidos = state.attachProgress.fallidos;
        state.attachProgress = fallidos.length ? { ...state.attachProgress, terminado: true } : null;
        renderWorkspace();
      }

      // Progreso en sitio: repintar todo en cada archivo haría parpadear la
      // pantalla 50 veces y perdería el foco de lo que el usuario esté haciendo.
      function pintarProgresoAdjuntos() {
        const p = state.attachProgress;
        const barra = document.querySelector("[data-attach-progress-bar]");
        const texto = document.querySelector("[data-attach-progress-text]");
        if (!p || !barra || !texto) return;
        const pct = Math.round((p.hechos * 100) / p.total);
        barra.style.width = `${pct}%`;
        texto.textContent = p.hechos < p.total
          ? `Subiendo ${p.hechos} de ${p.total}`
          : `${p.total - p.fallidos.length} de ${p.total} subidos`;
      }

      async function subirUno(projectId, file, path) {
        const presign = await apiRequest(`api/projects/${projectId}/attachments/presign`, {
          method: "POST",
          body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size }),
        });
        const { attachmentId, uploadUrl, contentType } = presign.data;
        const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: file });
        if (!put.ok) throw new Error("No se pudo subir al almacenamiento.");
        const confirmed = await apiRequest(`api/projects/${projectId}/attachments`, {
          method: "POST",
          body: JSON.stringify({ kind: "file", attachmentId, fileName: file.name,
                                 contentType, size: file.size, path: path || "" }),
        });
        const project = findProject(projectId);
        state.projectAttachments[projectId] = [confirmed.data, ...(attachmentsOf(projectId) || [])];
        if (project) project.attachmentsCount = (project.attachmentsCount || 0) + 1;
        return confirmed.data;
      }

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
            if (project) state.projectAttachments[projectId] = [confirmed.data, ...(attachmentsOf(projectId) || [])];
            if (project) project.attachmentsCount = (project.attachmentsCount || 0) + 1;
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
          if (project) state.projectAttachments[projectId] = [payload.data, ...(attachmentsOf(projectId) || [])];
          if (project) project.attachmentsCount = (project.attachmentsCount || 0) + 1;
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

      // Chip de carpeta de la bitácora → la carpeta desplegada en la franja
      // Adjuntos. El chip resume 89 archivos en un renglón: si el clic no lleva
      // hasta ellos es un botón muerto. La clave es la MISMA que usa el árbol
      // ("projectId::ruta"), por eso basta con marcarla abierta.
      function irACarpetaAdjuntos(clave) {
        const [projectId] = (clave || "").split("::");
        if (!projectId) return;
        state.attachSearch = "";              // con búsqueda activa el árbol se aplana
        state.attachTreeOpen[clave] = true;
        renderWorkspace();
        const fila = [...document.querySelectorAll("[data-attach-folder]")]
          .find((n) => n.dataset.attachFolder === clave);
        const destino = fila?.closest(".attachRow")
          || document.querySelector(`[data-attach-project="${projectId}"]`);
        if (!destino) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        destino.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
        // Mismo destello que al abrir el detalle o el form de entregable (docs/06 #2).
        if (!reduce && destino.animate) {
          destino.animate([
            { boxShadow: "0 0 0 0 rgba(15, 118, 110, 0)" },
            { boxShadow: "0 0 0 3px rgba(15, 118, 110, 0.45)", offset: 0.25 },
            { boxShadow: "0 0 0 0 rgba(15, 118, 110, 0)" },
          ], { duration: 900, easing: "ease-out" });
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
        // Confirmación ESPECÍFICA (con el nombre): el confirm genérico se acepta
        // en automático por hábito; nombrar lo que se borra obliga a leer.
        const att = (findProject(projectId)?.attachments || []).find((a) => a.id === attachmentId);
        const attName = att ? (att.kind === "query" ? (att.title || "Query") : (att.fileName || "archivo")) : "este adjunto";
        if (!window.confirm(`¿Eliminar "${attName}"? No se puede deshacer.`)) return;
        try {
          await apiRequest(`api/projects/${projectId}/attachments/${attachmentId}`, { method: "DELETE" });
          const project = findProject(projectId);
          if (project) state.projectAttachments[projectId] = (attachmentsOf(projectId) || []).filter((a) => a.id !== attachmentId);
          if (project) project.attachmentsCount = Math.max(0, (project.attachmentsCount || 1) - 1);
          delete state.attachSelected[attachmentId];
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
        const lista = attachmentsOf(project.id) || [];
        const idx = lista.findIndex((a) => a.id === attachmentId);
        if (idx >= 0) lista[idx] = { ...lista[idx], ...data };
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

      // Registrar a alguien Y sumarlo a la solicitud en un solo gesto. Las dos
      // llamadas van encadenadas a propósito: si el alta funciona pero la
      // asignación falla, la persona YA existe — se avisa en vez de fingir que
      // no pasó nada, y queda en el directorio lista para agregarla a mano.
      // El backend rechaza nombres duplicados, así que el mensaje que llega es
      // el suyo ("Ya existe una persona registrada como…").
      async function createPersonAndAssign(projectId, nombre, box) {
        const fullName = (nombre || "").trim();
        if (!projectId) return;
        if (!fullName) {
          box?.querySelector("[data-member-create-input]")?.focus({ preventScroll: true });
          return;
        }
        const boton = box?.querySelector("[data-member-create-save]");
        if (boton) { boton.disabled = true; boton.textContent = "Registrando…"; }
        let personId = null;
        try {
          const payload = await apiRequest("api/people", {
            method: "POST",
            body: JSON.stringify({ firstName: fullName }),
          });
          personId = payload.data.id;
          state.memberCreateFor = null;
          // El feedback es el chip apareciendo en "Personas relacionadas": no se
          // usa saveNotice porque solo se pinta en el panel de EDICIÓN, que aquí
          // normalmente está cerrado — sería un aviso que nadie ve.
          await addProjectMember(projectId, personId);   // refresca y repinta
        } catch (error) {
          alert(personId
            ? `${fullName} quedó registrada, pero no se pudo agregar a la solicitud: ${error.message}`
            : error.message);
          if (boton) { boton.disabled = false; boton.textContent = "Registrar y agregar"; }
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

      // ── Refresco en vivo (2026-07-28) ──────────────────────────────────────
      // Los usuarios recargaban la página cada rato "por si alguien actualizó".
      // Ahora se sondea un CONTADOR de versión (1 item, unos bytes) cada 20 s y
      // solo se baja el workspace completo (~180 KB) cuando ese número cambió.
      // Educado: solo con el módulo activo y la pestaña visible.
      //
      // REGLA DE SEGURIDAD: nunca repintar encima de alguien que está
      // escribiendo. Si hay un formulario abierto/enfocado, el refresco NO se
      // aplica solo — aparece un aviso discreto "Hay cambios nuevos · Actualizar"
      // y el usuario decide cuándo (así no se le borra lo que va escribiendo).
      const VERSION_POLL_MS = 20000;
      let versionTimer = null;
      let knownVersion = null;
      // Refrescos locales en curso (contador, no booleano: pueden solaparse dos
      // guardados). Mientras sea > 0 el sondeo no interpreta la versión: el salto
      // lo causó el propio usuario.
      let refrescoLocal = 0;

      // "Ocupado" = ESCRIBIENDO, no simplemente mirando. Tener una solicitud
      // seleccionada NO cuenta: seleccionar una fila es la forma normal de
      // trabajar, y contarlo como ocupado hacía que CUALQUIER cambio de
      // CUALQUIER solicitud sacara el aviso todo el tiempo (2026-07-29).
      function isUserBusy() {
        const el = document.activeElement;
        if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;   // tecleando
        if (state.updateEditing || state.taskUpdateEditing) return true;       // editando una entrada
        if (state.showTaskForm || state.showPersonForm) return true;           // alta abierta
        if (state.deliverableFormProject) return true;                         // entregable en curso
        if (state.attachQueryFor || state.attachNoteFor) return true;          // adjunto/nota en curso
        if (document.querySelector(".tlModal, .wsReportModal")) return true;   // modal abierto
        return false;
      }

      // ¿El cambio remoto toca la solicitud que el usuario tiene abierta? Se
      // compara el contenido de ESA solicitud entre lo que hay y lo que llegó:
      // permite avisar con precisión en vez de un genérico "algo cambió".
      function affectsOpenProject(freshData) {
        const openId = state.selectedDetail?.projectId || state.activeProjectId;
        if (!openId) return false;
        const before = (state.workspace?.projects || []).find((p) => p.id === openId);
        const after = (freshData?.projects || []).find((p) => p.id === openId);
        return JSON.stringify(before) !== JSON.stringify(after);
      }

      async function applyRemoteChanges() {
        if (state.pendingWorkspace) {
          state.workspace = state.pendingWorkspace;        // ya estaba bajado
          state.pendingWorkspace = null;
        } else {
          await loadWorkspace();
        }
        state.workspacePending = false;
        state.pendingTouchesOpen = false;
        document.querySelector("#wsPendingBanner")?.remove();
        renderWorkspace();
      }

      function startVersionPoll() {
        if (versionTimer) return;
        versionTimer = window.setInterval(async () => {
          if (state.activeModule !== "projects" || document.hidden) return;
          if (refrescoLocal) return;                    // guardado propio en curso
          // Si quedó un cambio pendiente y el usuario YA dejó de escribir, se
          // aplica solo: sin esto el aviso se quedaba pegado, porque la versión
          // ya coincidía y el ciclo salía antes de llegar a aplicarlo.
          if (state.workspacePending && !isUserBusy()) {
            await applyRemoteChanges();
            return;
          }
          try {
            const payload = await apiRequest("api/workspace/version");
            const version = payload.data?.version ?? 0;
            if (knownVersion === null) { knownVersion = version; return; }
            if (version === knownVersion) return;
            knownVersion = version;
            if (!isUserBusy()) {
              await applyRemoteChanges();                  // repintado silencioso
              return;
            }
            // Escribiendo: se BAJA el dato pero no se aplica. Así se puede decir
            // si el cambio toca lo que tiene abierto, y aplicarlo en cuanto deje
            // de escribir — sin pisarle nada.
            const fresh = await fetchWorkspaceData();
            if (!fresh) return;
            // El guardado propio pudo terminar mientras se bajaba esto: si ya se
            // aplicó localmente, avisar sería avisar de lo que el usuario acaba
            // de hacer. Se revisa DESPUÉS de los await, no solo al entrar.
            if (refrescoLocal) return;
            // Y si lo que llegó es idéntico a lo que ya está en pantalla, no hay
            // nada que anunciar: es justo el caso del cambio propio ya aplicado.
            if (JSON.stringify(fresh) === JSON.stringify(state.workspace)) return;
            state.pendingWorkspace = fresh;
            state.workspacePending = true;
            state.pendingTouchesOpen = affectsOpenProject(fresh);
            renderPendingBanner();
          } catch { /* sin red: se reintenta al próximo tick */ }
        }, VERSION_POLL_MS);
      }

      // El aviso se inserta/actualiza SIN repintar el módulo (repintar sería
      // justo lo que se está evitando mientras el usuario escribe).
      function renderPendingBanner() {
        if (!state.workspacePending) {
          document.querySelector("#wsPendingBanner")?.remove();
          return;
        }
        if (document.querySelector("#wsPendingBanner")) return;
        const bar = document.createElement("div");
        bar.id = "wsPendingBanner";
        bar.className = "wsPendingBanner";
        // Mensaje concreto: no es lo mismo que hayan tocado LO QUE ESTÁS VIENDO
        // que un cambio en otra solicitud del portafolio.
        const texto = state.pendingTouchesOpen
          ? "Actualizaron la solicitud que tienes abierta."
          : "Hay cambios en otras solicitudes.";
        bar.innerHTML = `<span>${escapeHtml(texto)}</span>
          <button type="button" class="tinyButton">Actualizar</button>`;
        bar.querySelector("button").addEventListener("click", async () => {
          bar.remove();
          await applyRemoteChanges();
        });
        document.body.appendChild(bar);
      }

      async function refreshWorkspace() {
        // Marca que hay un refresco LOCAL en curso: mientras dure, el sondeo no
        // interpreta la versión del servidor. Sin esto el sondeo veía el salto
        // de versión que causó el propio guardado del usuario y levantaba el
        // aviso por su propio cambio (2026-08-05).
        refrescoLocal += 1;
        try {
        // Mantiene lo ya pintado mientras llega lo nuevo — sin pasar por la
        // pantalla "Cargando" (ese parpadeo hacía sentir lento cada guardado).
        await loadWorkspace();
        state.workspacePending = false;
        // Se TIRA la foto pendiente, que es anterior a este guardado. Si se
        // deja, el siguiente `applyRemoteChanges` la prefiere sobre pedir datos
        // frescos y revierte lo que el usuario acaba de escribir: el seguimiento
        // desaparecía de la pantalla hasta recargar la página (2026-08-05).
        state.pendingWorkspace = null;
        state.pendingTouchesOpen = false;
        renderPendingBanner();
        // El guardado propio ya subió la versión: se toma la nueva como conocida
        // para no avisar al usuario de su propio cambio.
        try {
          const payload = await apiRequest("api/workspace/version");
          knownVersion = payload.data?.version ?? knownVersion;
        } catch { /* si falla, el próximo sondeo lo corrige */ }
        renderWorkspace();
        } finally {
          refrescoLocal -= 1;
        }
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

  // ── Reporte ejecutivo (LLM + plantillas de diagrama propias) ────────────────
  // El modelo decide el CONTENIDO (qué solicitudes, qué nivel, qué hitos); estas
  // plantillas SVG deciden el DIBUJO — determinista, siempre profesional. El spec
  // llega ya validado/recortado por el backend.
  const RAG_COLORS = { verde: "#15803d", ambar: "#b45309", rojo: "#b91c1c" };
  const RAG_BG = { verde: "#dcfce7", ambar: "#fef3c7", rojo: "#fee2e2" };
  const TL_COLORS = { hito: "#0f766e", entrega: "#1d4ed8", alerta: "#b91c1c" };

  function svgText(x, y, text, size, opts = {}) {
    return `<text x="${x}" y="${y}" font-size="${size}" font-family="Inter, ui-sans-serif, sans-serif"`
      + `${opts.bold ? ' font-weight="700"' : ""}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ""}`
      + ` fill="${opts.fill || "#1b272b"}">${escapeHtml(text)}</text>`;
  }
  function diagramTitleSvg(title, width) {
    return title ? svgText(16, 26, title, 14, { bold: true }) : "";
  }

  // Truncado defensivo: SVG no envuelve texto solo, y un nombre largo se
  // encimaría con la columna siguiente (pasó con nombres de ~30 caracteres).
  function svgTrunc(s, max) {
    s = String(s || "");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function ragSvg(spec) {
    const W = 720, rowH = 40, top = spec.title ? 44 : 16;
    const nameX = 52, noteX = 268, chipW = 92;
    const H = top + spec.items.length * rowH + 12;
    const rows = spec.items.map((it, i) => {
      const y = top + i * rowH;
      const color = RAG_COLORS[it.level], bg = RAG_BG[it.level];
      return `
        <rect x="12" y="${y}" width="${W - 24}" height="${rowH - 8}" rx="8" fill="${i % 2 ? "#ffffff" : "#f8fbfb"}" stroke="#d8e1e4"/>
        <circle cx="34" cy="${y + (rowH - 8) / 2}" r="8" fill="${color}"/>
        ${svgText(nameX, y + 20, svgTrunc(it.name, 28), 13, { bold: true })}
        ${it.note ? svgText(noteX, y + 20, svgTrunc(it.note, 48), 12, { fill: "#62737a" }) : ""}
        ${it.dueDate ? `<rect x="${W - chipW - 24}" y="${y + 6}" width="${chipW}" height="20" rx="10" fill="${bg}"/>` + svgText(W - 24 - chipW / 2, y + 20, it.dueDate, 11, { anchor: "middle", fill: color }) : ""}`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="background:#fff">${diagramTitleSvg(spec.title, W)}${rows}</svg>`;
  }

  function progressSvg(spec) {
    const W = 680, rowH = 42, top = spec.title ? 48 : 20, labelW = 210, barW = W - labelW - 150;
    const H = top + spec.items.length * rowH + 12;
    const rows = spec.items.map((it, i) => {
      const y = top + i * rowH;
      const pct = it.progress, fillW = Math.round(barW * pct / 100);
      const color = pct >= 80 ? "#15803d" : pct >= 40 ? "#0f766e" : "#b45309";
      return `
        ${svgText(labelW - 8, y + 16, svgTrunc(it.name, 28), 12.5, { anchor: "end", bold: true })}
        <rect x="${labelW}" y="${y + 4}" width="${barW}" height="18" rx="9" fill="#eef2f4"/>
        ${fillW > 0 ? `<rect x="${labelW}" y="${y + 4}" width="${Math.max(fillW, 14)}" height="18" rx="9" fill="${color}"/>` : ""}
        ${svgText(labelW + barW + 10, y + 18, `${pct}%`, 12, { bold: true, fill: color })}
        ${it.dueDate ? svgText(labelW + barW + 52, y + 18, it.dueDate, 11, { fill: "#62737a" }) : ""}`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="background:#fff">${diagramTitleSvg(spec.title, W)}${rows}</svg>`;
  }

  function timelineSvg(spec) {
    const items = spec.items.slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const W = 760, top = spec.title ? 56 : 30, axisY = top + 130, H = axisY + 96;
    const t0 = new Date(items[0].date).getTime(), t1 = new Date(items[items.length - 1].date).getTime();
    const span = Math.max(t1 - t0, 86400000), pad = 56;
    const px = (d) => pad + (new Date(d).getTime() - t0) / span * (W - pad * 2);
    // Marcas de semana sobre el eje.
    let weeks = "";
    const start = new Date(t0); start.setDate(start.getDate() - start.getDay() + 1);
    for (let w = new Date(start); w.getTime() <= t1 + 86400000 * 6; w.setDate(w.getDate() + 7)) {
      const x = px(w);
      if (x < pad - 6 || x > W - pad + 6) continue;
      weeks += `<line x1="${x}" y1="${axisY - 6}" x2="${x}" y2="${axisY + 6}" stroke="#c0ced2" stroke-width="1"/>`
        + svgText(x, axisY + 22, `${String(w.getDate()).padStart(2, "0")}/${String(w.getMonth() + 1).padStart(2, "0")}`, 10, { anchor: "middle", fill: "#62737a" });
    }
    // Hoy.
    const now = Date.now();
    const todayMark = (now >= t0 - 86400000 && now <= t1 + 86400000)
      ? `<line x1="${px(now)}" y1="${top - 8}" x2="${px(now)}" y2="${axisY}" stroke="#b91c1c" stroke-width="1.5" stroke-dasharray="4 3"/>` + svgText(px(now), top - 14, "hoy", 10, { anchor: "middle", fill: "#b91c1c" })
      : "";
    // Hitos alternando altura para que las etiquetas no choquen.
    const marks = items.map((it, i) => {
      const x = px(it.date), lift = 26 + (i % 3) * 34, color = TL_COLORS[it.kind];
      return `
        <line x1="${x}" y1="${axisY - lift + 10}" x2="${x}" y2="${axisY}" stroke="${color}" stroke-width="1.2"/>
        <circle cx="${x}" cy="${axisY}" r="5.5" fill="${color}"/>
        ${svgText(x, axisY - lift, it.label.length > 34 ? it.label.slice(0, 33) + "…" : it.label, 11, { anchor: "middle", bold: true, fill: color })}
        ${svgText(x, axisY - lift + 13, it.date.slice(5), 9.5, { anchor: "middle", fill: "#62737a" })}`;
    }).join("");
    const legend = Object.entries({ hito: "Hito", entrega: "Entrega", alerta: "Alerta" }).map(([k, lab], i) =>
      `<circle cx="${pad + i * 110}" cy="${H - 24}" r="5" fill="${TL_COLORS[k]}"/>` + svgText(pad + i * 110 + 12, H - 20, lab, 11, { fill: "#62737a" })).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="background:#fff">
      ${diagramTitleSvg(spec.title, W)}
      <line x1="${pad - 16}" y1="${axisY}" x2="${W - pad + 16}" y2="${axisY}" stroke="#62737a" stroke-width="1.5"/>
      ${weeks}${todayMark}${marks}${legend}</svg>`;
  }

  function diagramSvg(spec) {
    if (!spec || !spec.items || !spec.items.length) return "";
    if (spec.type === "rag") return ragSvg(spec);
    if (spec.type === "progress") return progressSvg(spec);
    if (spec.type === "timeline") return timelineSvg(spec);
    return "";
  }

  function downloadDiagramPng(svgEl, filename) {
    const xml = new XMLSerializer().serializeToString(svgEl);
    const scale = 2;   // nítido en proyector/presentación
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = svgEl.viewBox.baseVal.width * scale;
      canvas.height = svgEl.viewBox.baseVal.height * scale;
      const ctx2 = canvas.getContext("2d");
      ctx2.fillStyle = "#ffffff";
      ctx2.fillRect(0, 0, canvas.width, canvas.height);
      ctx2.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  }

  const REPORT_PRESETS = [
    { kind: "criticos", label: "🔴 Temas críticos y entregas" },
    { kind: "detenidos", label: "⛔ Qué está detenido" },
    { kind: "avance", label: "📈 Avance general" },
    { kind: "hitos", label: "📅 Línea de tiempo de hitos" },
  ];

  function openReportModal() {
    const modal = document.createElement("div");
    modal.className = "wsReportModal";
    modal.innerHTML = `
      <div class="wsReportDialog" role="dialog" aria-label="Reporte ejecutivo">
        <div class="wsReportHead">
          <h3>📊 Reporte ejecutivo</h3>
          <button type="button" class="wsReportClose" aria-label="Cerrar">×</button>
        </div>
        <div class="wsReportAsk">
          <div class="wsReportPresets">
            ${REPORT_PRESETS.map((p) => `<button type="button" class="wsReportPreset" data-kind="${p.kind}">${p.label}</button>`).join("")}
          </div>
          <div class="wsReportFree">
            <input type="text" class="wsReportInput" placeholder="…o pídelo con tus palabras (ej. solo el área de Riesgos que vence este mes)" maxlength="500" />
            <button type="button" class="primaryButton wsReportGo">Generar</button>
          </div>
        </div>
        <div class="wsReportBody"><p class="wsReportHint">Elige un preajuste o escribe qué necesitas. El reporte se genera con IA sobre los datos actuales de las solicitudes.</p></div>
      </div>`;
    document.body.appendChild(modal);
    const body = modal.querySelector(".wsReportBody");
    // Token de generación: cada pedido nuevo lo incrementa y el sondeo del pedido
    // anterior se aborta solo al notar que ya no es el vigente. Así "Cancelar" y
    // pedir otro preajuste a media generación funcionan sin cerrar el modal (el
    // worker del backend termina igual en segundo plano; su resultado expira solo).
    let genSeq = 0;

    function close() { genSeq++; modal.remove(); }
    modal.querySelector(".wsReportClose").onclick = close;
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    modal.tabIndex = -1; modal.focus();
    modal.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    function cancelGeneration() {
      genSeq++;
      body.innerHTML = `<p class="wsReportHint">Generación cancelada. Elige un preajuste o escribe qué necesitas.</p>`;
    }

    // Qué se pidió (preajuste o texto libre): va en el encabezado del PDF para
    // que el documento se explique solo fuera de la app.
    let lastAsk = "";

    async function generate(kind, text) {
      lastAsk = kind
        ? (REPORT_PRESETS.find((p) => p.kind === kind)?.label || "").replace(/^\S+\s/, "")
        : (text || "").trim();
      const seq = ++genSeq;   // reemplaza cualquier generación en curso
      body.innerHTML = `
        <p class="wsReportLoading">Generando reporte… puede tardar hasta un minuto (analiza todas las solicitudes).</p>
        <button type="button" class="tinyButton wsReportCancel">Cancelar</button>`;
      body.querySelector(".wsReportCancel").onclick = cancelGeneration;
      try {
        const start = await apiRequest("api/workspace/report", {
          method: "POST", body: JSON.stringify({ kind: kind || "", text: text || "" }),
        });
        const reportId = start.data.reportId;
        for (let i = 0; i < 100 && seq === genSeq; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          if (seq !== genSeq) return;               // cancelado o reemplazado
          const p = await apiRequest(`api/workspace/report/${encodeURIComponent(reportId)}`);
          if (seq !== genSeq) return;
          if (p.data.status === "generating") continue;
          renderResult(p.data);
          return;
        }
        if (seq === genSeq) body.innerHTML = `<p class="wsReportError">El reporte está tardando más de lo esperado. Vuelve a intentarlo.</p>`;
      } catch (err) {
        if (seq === genSeq) body.innerHTML = `<p class="wsReportError">${escapeHtml(err?.message || "No se pudo generar el reporte.")}</p>`;
      }
    }

    function renderResult(data) {
      const svg = diagramSvg(data.diagram);
      body.innerHTML = `
        <div class="wsReportActions">
          <button type="button" class="tinyButton wsReportCopy">⧉ Copiar texto</button>
          <button type="button" class="tinyButton wsReportPdf" title="Abre el diálogo de impresión: elige «Guardar como PDF»">⬇ Descargar PDF</button>
          ${svg ? `<button type="button" class="tinyButton wsReportPng">⬇ Descargar diagrama</button>` : ""}
        </div>
        <div class="wsReportText">${mdLite(data.report || "")}</div>
        ${svg ? `<div class="wsReportDiagram">${svg}</div>` : ""}`;
      body.querySelector(".wsReportCopy").onclick = async (e) => {
        try {
          await navigator.clipboard.writeText(data.report || "");
          e.target.textContent = "✓ Copiado";
          setTimeout(() => { e.target.textContent = "⧉ Copiar texto"; }, 1400);
        } catch {}
      };
      const pngBtn = body.querySelector(".wsReportPng");
      if (pngBtn) pngBtn.onclick = () => {
        const el = body.querySelector(".wsReportDiagram svg");
        if (el) downloadDiagramPng(el, "reporte-solicitudes.png");
      };
      body.querySelector(".wsReportPdf").onclick = () => printReportPdf(data, lastAsk);
    }

    // PDF del reporte COMPLETO (texto + diagrama). Se arma un documento
    // autocontenido en un iframe oculto y se manda a imprimir: el usuario elige
    // "Guardar como PDF" (destino nativo en Chrome/Edge/Safari). Se prefiere esto
    // a empaquetar un generador de PDF porque el resultado sale mejor y sin peso
    // extra: el texto queda SELECCIONABLE, el diagrama VECTORIAL (es SVG, no una
    // captura) y la paginación/saltos los resuelve el navegador. Regla del
    // proyecto: nada de CDNs externos — aquí no hace falta ninguna dependencia.
    function printReportPdf(data, ask) {
      const svg = diagramSvg(data.diagram);
      const now = new Date().toLocaleString("es-GT", {
        year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", timeZone: "America/Guatemala",
      });
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
      document.body.appendChild(frame);
      const doc = frame.contentDocument;
      doc.open();
      doc.write(`<!doctype html><html lang="es"><head><meta charset="utf-8" />
        <title>Reporte ejecutivo — Gestión de Datos</title>
        <style>
          @page { size: A4; margin: 18mm 16mm; }
          * { box-sizing: border-box; }
          body { margin: 0; font: 11pt/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1c2528; }
          header { border-bottom: 2px solid #2f6f63; padding-bottom: 10px; margin-bottom: 18px; }
          header h1 { margin: 0 0 4px; font-size: 17pt; color: #14322c; }
          header .meta { font-size: 9pt; color: #5c6b70; }
          h1, h2, h3, h4 { color: #14322c; line-height: 1.25; break-after: avoid; }
          h2 { font-size: 13pt; margin: 16px 0 6px; }
          h3 { font-size: 11.5pt; margin: 14px 0 5px; }
          p, li { orphans: 3; widows: 3; }
          ul, ol { padding-left: 20px; }
          table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 9.5pt; break-inside: avoid; }
          th, td { border: 1px solid #cfd8da; padding: 5px 7px; text-align: left; vertical-align: top; }
          th { background: #eef4f3; }
          pre { background: #f4f7f7; padding: 8px; border-radius: 4px; font-size: 9pt; white-space: pre-wrap; }
          code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 9.5pt; }
          hr { border: 0; border-top: 1px solid #dfe6e7; margin: 14px 0; }
          .diagram { margin-top: 18px; break-inside: avoid; }
          .diagram svg { max-width: 100%; height: auto; }
          footer { margin-top: 22px; padding-top: 8px; border-top: 1px solid #dfe6e7;
                   font-size: 8.5pt; color: #7b898e; }
        </style></head><body>
        <header>
          <h1>Reporte ejecutivo — Solicitudes</h1>
          <div class="meta">Gerencia Administrativa de Datos · ${escapeHtml(now)} (hora de Guatemala)${
            ask ? ` · Consulta: ${escapeHtml(ask)}` : ""}</div>
        </header>
        ${mdLite(data.report || "")}
        ${svg ? `<div class="diagram">${svg}</div>` : ""}
        <footer>Generado con IA sobre los datos vigentes de las solicitudes al momento de la consulta. Verifica las cifras antes de difundirlo.</footer>
      </body></html>`);
      doc.close();
      const go = () => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } catch { /* si el navegador lo bloquea, el usuario aún tiene "Copiar texto" */ }
        // El iframe se retira DESPUÉS del diálogo (quitarlo antes cancela la
        // impresión en algunos navegadores).
        setTimeout(() => frame.remove(), 60000);
      };
      // Esperar al layout del SVG antes de imprimir (si no, sale en blanco).
      if (frame.contentWindow.document.readyState === "complete") requestAnimationFrame(go);
      else frame.onload = () => requestAnimationFrame(go);
    }

    for (const b of modal.querySelectorAll(".wsReportPreset")) {
      b.addEventListener("click", () => generate(b.dataset.kind, ""));
    }
    const goBtn = modal.querySelector(".wsReportGo");
    const input = modal.querySelector(".wsReportInput");
    goBtn.addEventListener("click", () => generate("", input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") generate("", input.value); });
  }

  // El sondeo arranca con el módulo (idempotente) y se apaga solo cuando el
  // módulo no está activo o la pestaña no se ve.
  startVersionPoll();

  return { render: renderWorkspace, refresh: refreshWorkspace };
}
