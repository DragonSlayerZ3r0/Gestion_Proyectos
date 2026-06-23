// @ts-nocheck
// Módulo Proyectos y tareas (workspace). Inyección de dependencias desde el shell.
export function createWorkspaceModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, priorityLabel } = ctx;

      async function renderWorkspace() {
        elements.statusPanel.hidden = true;
        elements.contentPanel.hidden = false;
        elements.viewTitle.textContent = "Proyectos y tareas";
        elements.contentPanel.className = "workspaceLayout";

        if (!state.workspace) {
          elements.contentPanel.innerHTML = `<section class="panel"><h2>Cargando espacio de trabajo</h2><p>Preparando personas, proyectos y tareas.</p></section>`;
          try {
            await loadWorkspace();
          } catch (error) {
            elements.contentPanel.innerHTML = `
              <section class="panel">
                <h2>No fue posible cargar proyectos y tareas</h2>
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
        const projectCards = visibleProjects.map((project) => renderProjectCard(project, activeProject?.id === project.id, peopleById)).join("");
        const projectCountText = `${visibleProjects.length} de ${workspace.projects.length} proyectos`;
        const personCreatedNotice = state.saveNotice?.target === "person-create" ? state.saveNotice.message : "";
        const visiblePeople = getVisiblePeople(workspace.people);
        const personDirectory = renderPeopleDirectory(visiblePeople);
        const peopleCountText = state.personSearch.trim()
          ? `${visiblePeople.length} de ${workspace.people.length}`
          : String(workspace.people.length);
        const selectedPersonDetail = renderSelectedPersonDetail();

        elements.contentPanel.innerHTML = `
          <section class="projectOverview">
            <section class="panel workspaceHero">
              <div class="workspaceHeroText">
                <p class="eyebrow">Vista operativa</p>
                <h2>Proyectos con tareas visibles</h2>
                <p>Consulta responsables, personas relacionadas y tareas principales sin cambiar de pantalla.</p>
              </div>
              <form id="projectQuickForm" class="projectCreateForm">
                <input name="name" type="text" placeholder="Nuevo proyecto" required />
                <button class="primaryButton" type="submit">Crear proyecto</button>
              </form>
              <div class="workspaceControls">
                <input id="projectSearch" class="searchInput" type="search" placeholder="Buscar en proyectos y tareas" value="${escapeAttribute(state.projectSearch)}" />
                <div class="searchScope" role="group" aria-label="Buscar en">
                  ${renderProjectSearchScopeButton("projects", "Proyectos")}
                  ${renderProjectSearchScopeButton("tasks", "Tareas")}
                </div>
                <button id="togglePersonFormButton" class="secondaryButton compact" type="button">${state.showPersonForm ? "Cancelar" : "Registrar persona"}</button>
              </div>
              <form id="personQuickForm" class="personCreateForm" ${state.showPersonForm ? "" : "hidden"}>
                <input name="firstName" type="text" placeholder="Nombre" required />
                <input name="lastName" type="text" placeholder="Apellido" required />
                <details class="optionalDetails">
                  <summary>Más datos</summary>
                  <input name="area" type="text" placeholder="Área" />
                  <textarea name="availabilityNotes" rows="2" placeholder="Vacaciones o disponibilidad"></textarea>
                  <textarea name="notes" rows="2" placeholder="Notas"></textarea>
                </details>
                <button class="primaryButton" type="submit">Registrar persona</button>
              </form>
              ${personCreatedNotice ? `<p class="saveFeedback compactFeedback" role="status">${escapeHtml(personCreatedNotice)}</p>` : ""}
              <section class="personDirectory ${selectedPersonDetail ? "hasDetail" : ""}" data-people-drop-zone>
                <div class="blockHeader">
                  <div>
                    <strong>Personas registradas</strong>
                    <span>Arrastra una persona a un proyecto para agregarla.</span>
                  </div>
                  <span>${peopleCountText}</span>
                </div>
                <input id="personSearch" class="searchInput personSearchInput" type="search" placeholder="Buscar persona" value="${escapeAttribute(state.personSearch)}" />
                <div class="peopleStrip">
                  ${personDirectory || renderPeopleEmptyState(workspace.people.length)}
                </div>
                ${selectedPersonDetail ? `<section class="detailDrawerSlot personDetailSlot">${selectedPersonDetail}</section>` : ""}
              </section>
              <div class="projectFilters" role="group" aria-label="Filtrar proyectos por estado">
                ${renderProjectStatusFilters()}
              </div>
              <div class="workspaceCount">
                <span class="countPill">${projectCountText}</span>
                <span>${workspace.people.length} personas registradas</span>
              </div>
            </section>

            <section class="overviewProjectList">
              ${projectCards || `<section class="panel"><p class="emptyText">${workspace.projects.length ? "No hay resultados con los filtros actuales." : "Crea el primer proyecto para iniciar."}</p></section>`}
            </section>
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
        return projects.filter((project) => {
          if (state.projectStatusFilter === "none" && project.status) {
            return false;
          }
          if (state.projectStatusFilter !== "all" && state.projectStatusFilter !== "none" && project.status !== state.projectStatusFilter) {
            return false;
          }
          if (!query) {
            return true;
          }
          const matchesProject = state.projectSearchScopes.projects && projectSearchText(project, peopleById).includes(query);
          const matchesTasks = state.projectSearchScopes.tasks && project.tasks.some((task) => taskSearchText(task, peopleById).includes(query));
          return matchesProject || matchesTasks;
        });
      }

      function projectSearchText(project, peopleById) {
        const owner = peopleById[project.ownerPersonId]?.fullName || "";
        const members = project.members
          .map((member) => peopleById[member.personId]?.fullName || "")
          .join(" ");
        return normalizeSearch(`${project.name} ${project.description || ""} ${owner} ${members}`);
      }

      function taskSearchText(task, peopleById) {
        const assignee = peopleById[task.assigneePersonId]?.fullName || "";
        return normalizeSearch(`${task.title} ${task.notes || ""} ${assignee} ${priorityLabel(task.priority)} ${taskStatusLabel(task.status)} ${task.status || ""}`);
      }

      function normalizeSearch(value) {
        return String(value || "").trim().toLowerCase();
      }

      function taskStatusLabel(statusKey) {
        return state.workspace?.taskStatuses.find((status) => status.key === statusKey)?.label || "";
      }

      function renderProjectStatusFilters() {
        const options = [
          ["all", "Todos"],
          ["none", "Sin estado"],
          ["planned", "Planificados"],
          ["active", "Activos"],
          ["paused", "Pausados"],
          ["closed", "Cerrados"]
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

      function renderProjectSearchScopeButton(scope, label) {
        const isActive = Boolean(state.projectSearchScopes[scope]);
        return `
          <button
            class="scopeChip ${isActive ? "active" : ""}"
            type="button"
            data-project-search-scope="${scope}"
            aria-pressed="${isActive ? "true" : "false"}"
          >${label}</button>
        `;
      }

      function renderPersonCard(person) {
        const isSelected = state.selectedDetail?.type === "person" && state.selectedDetail.id === person.id;
        return `
          <article class="personCard ${isSelected ? "selected" : ""}" draggable="true" data-person-id="${person.id}" data-person-select="${person.id}">
            <div class="cardHeader">
              <strong>${escapeHtml(person.fullName)}</strong>
              ${renderEditIconButton("Editar persona", `data-detail-person="${person.id}"`)}
            </div>
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
        return `<p class="emptyText">Registra la primera persona para asignarla a proyectos y tareas.</p>`;
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
                title="Quitar del proyecto"
                aria-label="Quitar a ${escapeAttribute(person.fullName)} del proyecto"
              >×</button></span>
            `;
          })
          .join("");
        const memberIds = new Set(project.members.map((member) => member.personId));
        const availablePeople = state.workspace.people.filter((person) => !memberIds.has(person.id));
        const isSelected = state.selectedDetail?.type === "project" && state.selectedDetail.id === project.id;
        const owner = peopleById[project.ownerPersonId] || null;
        const summary = renderTaskSummary(project);
        const taskGroups = renderProjectTaskGroups(project, peopleById);
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
                  <p class="eyebrow">Proyecto</p>
                  <h2>${escapeHtml(project.name)}</h2>
                  ${owner ? `<p>Responsable: <strong>${escapeHtml(owner.fullName)}</strong></p>` : ""}
                </div>
                ${project.status ? `<span class="statusBadge ${projectStatusClass(project.status)}" data-status="${escapeAttribute(project.status)}">${projectStatusLabel(project.status)}</span>` : ""}
              </div>

              <div class="projectOverviewGrid">
                <section class="projectPeopleBlock">
                  <div class="blockHeader">
                    <strong>Personas relacionadas</strong>
                    <span>${project.members.length}</span>
                  </div>
                  <div class="memberChipList spacious">
                    ${memberChips || `<span class="emptyText">Agrega personas al proyecto.</span>`}
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

              ${boardOpen ? "" : `<div class="projectTaskGroups">${taskGroups}</div>`}

              <form class="inlineForm projectTaskForm" data-task-quick-project="${project.id}" ${taskFormOpen ? "" : "hidden"}>
                <input name="title" type="text" placeholder="Nueva tarea" required />
                <button class="primaryButton" type="submit">Crear tarea</button>
              </form>

              ${cardNotice ? `<p class="saveFeedback compactFeedback" role="status">${escapeHtml(cardNotice)}</p>` : ""}

              <div class="projectActions">
                <button class="tinyButton" type="button" data-toggle-task-form="${project.id}">${taskFormOpen ? "Cancelar" : "Crear tarea"}</button>
                <button class="tinyButton ghost" type="button" data-toggle-board="${project.id}">${boardOpen ? "Ocultar tablero" : "Ver tablero"}</button>
                ${renderEditIconButton("Editar proyecto", `data-detail-project="${project.id}"`)}
              </div>

              ${boardOpen ? `<div class="kanbanBoard compactBoard">${columns}</div>` : ""}
            </div>
            ${detailPanel ? `<section class="detailDrawerSlot">${detailPanel}</section>` : ""}
          </article>
        `;
      }

      function renderTaskSummary(project) {
        return state.workspace.taskStatuses
          .map((status) => {
            const count = project.tasks.filter((task) => task.status === status.key).length;
            return `${count} ${status.label.toLowerCase()}`;
          })
          .join(" · ");
      }

      function renderProjectTaskGroups(project, peopleById) {
        return state.workspace.taskStatuses
          .map((status) => {
            const tasks = project.tasks.filter((task) => task.status === status.key);
            const visibleTasks = tasks.slice(0, 3);
            return `
              <section class="taskGroup ${taskStatusClass(status.key)}">
                <header>
                  <strong>${status.label}</strong>
                  <span>${tasks.length}</span>
                </header>
                <div class="taskGroupList">
                  ${visibleTasks.length ? visibleTasks.map((task) => renderTaskSummaryRow(task, peopleById)).join("") : `<p class="emptyText">Sin tareas.</p>`}
                  ${tasks.length > visibleTasks.length ? `<button class="textButton" type="button" data-toggle-board="${project.id}">Ver ${tasks.length - visibleTasks.length} tareas más</button>` : ""}
                </div>
              </section>
            `;
          })
          .join("");
      }

      function renderTaskSummaryRow(task, peopleById) {
        const assignee = task.assigneePersonId ? peopleById[task.assigneePersonId] : null;
        return `
          <article class="taskSummaryRow">
            <div>
              <strong>${escapeHtml(task.title)}</strong>
              <span>Responsable: ${escapeHtml(assignee?.fullName || "Sin responsable")}</span>
              ${task.priority ? `<span class="priorityBadge ${priorityClass(task.priority)}">${priorityLabel(task.priority)}</span>` : ""}
            </div>
            ${renderEditIconButton("Editar tarea", `data-detail-task="${task.id}" data-detail-task-project="${task.projectId}"`)}
          </article>
        `;
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
              <button class="tinyButton ghost" type="button" data-close-detail>Cerrar</button>
            </div>
            <form id="personDetailForm" class="detailForm" data-person-detail="${person.id}">
              <label>Nombre<input name="firstName" type="text" value="${escapeAttribute(person.firstName)}" required /></label>
              <label>Apellido<input name="lastName" type="text" value="${escapeAttribute(person.lastName)}" required /></label>
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
                <p class="eyebrow">Proyecto</p>
                <h2>${escapeHtml(project.name)}</h2>
              </div>
              <button class="tinyButton ghost" type="button" data-close-detail>Cerrar</button>
            </div>
            <form id="projectDetailForm" class="detailForm" data-project-detail="${project.id}">
              <label>Nombre<input name="name" type="text" value="${escapeAttribute(project.name)}" required /></label>
              <label>Estado
                <select name="status">
                  ${projectStatusOptions(project.status)}
                </select>
              </label>
              <label>Responsable
                <select name="ownerPersonId">
                  <option value="">Ninguno</option>
                  ${state.workspace.people.map((person) => `<option value="${person.id}" ${person.id === project.ownerPersonId ? "selected" : ""}>${escapeHtml(person.fullName)}</option>`).join("")}
                </select>
              </label>
              <label>Descripción<textarea name="description" rows="4">${escapeHtml(project.description)}</textarea></label>
              <button class="primaryButton" type="submit">Guardar proyecto</button>
              ${notice ? `<p class="saveFeedback" role="status">${escapeHtml(notice)}</p>` : ""}
            </form>
            <div class="detailList">
              <strong>Miembros</strong>
              ${project.members.length ? project.members.map((member) => renderMemberRoleControl(project.id, member, peopleById)).join("") : `<p class="emptyText">Aún no hay miembros asignados.</p>`}
            </div>
            <div class="detailDanger">
              <button class="dangerButton" type="button" data-delete-project="${project.id}" data-delete-name="${escapeAttribute(project.name)}">Eliminar proyecto</button>
            </div>
          </aside>
        `;
      }

      function renderMemberRoleControl(projectId, member, peopleById) {
        const person = peopleById[member.personId];
        return `
          <label class="memberRoleRow">
            <span
              class="memberChip inline"
              draggable="true"
              data-member-drag-project="${projectId}"
              data-member-drag-person="${member.personId}"
            >${escapeHtml(person?.fullName || "Persona no encontrada")}</span>
            <select data-member-role="${projectId}" data-member-person="${member.personId}" aria-label="Rol de la persona">
              <option value="owner" ${member.role === "owner" ? "selected" : ""}>Responsable</option>
              <option value="member" ${member.role === "member" ? "selected" : ""}>Miembro</option>
              <option value="reader" ${member.role === "reader" ? "selected" : ""}>Lector</option>
            </select>
          </label>
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
              <button class="tinyButton ghost" type="button" data-close-detail>Cerrar</button>
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

      function projectStatusOptions(currentStatus) {
        return [
          ["", "Ninguno"],
          ...Object.entries(projectStatusLabels())
        ]
          .map(([key, label]) => `<option value="${key}" ${key === currentStatus ? "selected" : ""}>${label}</option>`)
          .join("");
      }

      function projectStatusLabel(status) {
        return projectStatusLabels()[status] || "Sin estado";
      }

      function projectStatusClass(status) {
        return `projectStatus-${status || "unknown"}`;
      }

      function projectStatusLabels() {
        return {
          planned: "Planificado",
          active: "Activo",
          paused: "Pausado",
          closed: "Cerrado"
        };
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
            if (!scope || !(scope in state.projectSearchScopes)) {
              return;
            }
            const nextValue = !state.projectSearchScopes[scope];
            const otherScope = scope === "projects" ? "tasks" : "projects";
            if (!nextValue && !state.projectSearchScopes[otherScope]) {
              return;
            }
            state.projectSearchScopes = {
              ...state.projectSearchScopes,
              [scope]: nextValue
            };
            renderWorkspace();
          });
        }

        for (const form of document.querySelectorAll("[data-task-quick-project]")) {
          form.addEventListener("submit", submitTaskForm);
        }

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

        for (const button of document.querySelectorAll("[data-project-select]")) {
          button.addEventListener("click", () => {
            state.activeProjectId = button.dataset.projectSelect;
            renderWorkspace();
          });
        }

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

        for (const select of document.querySelectorAll("[data-member-role]")) {
          select.addEventListener("change", async () => {
            try {
              await updateProjectMember(select.dataset.memberRole, select.dataset.memberPerson, { role: select.value });
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
            if (!window.confirm(`¿Eliminar a "${name}"? También se quitará de los proyectos donde participe. Esta acción no se puede deshacer.`)) return;
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
            const name = button.dataset.deleteName || "este proyecto";
            if (!window.confirm(`¿Eliminar el proyecto "${name}"? Se borrarán también sus tareas y asignaciones. Esta acción no se puede deshacer.`)) return;
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
        }
      }

      async function submitProjectForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        try {
          const payload = await apiRequest("api/projects", {
            method: "POST",
            body: JSON.stringify(Object.fromEntries(form.entries()))
          });
          state.activeProjectId = payload.data.id;
          state.selectedDetail = { type: "project", id: payload.data.id };
          state.saveNotice = { target: `project-create:${payload.data.id}`, message: "Proyecto creado." };
          target.reset();
          await refreshWorkspace();
        } catch (error) {
          alert(error.message);
        }
      }

      async function submitPersonDetailForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        try {
          await updatePerson(target.dataset.personDetail, Object.fromEntries(form.entries()));
        } catch (error) {
          alert(error.message);
        }
      }

      async function submitProjectDetailForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        try {
          await updateProject(target.dataset.projectDetail, Object.fromEntries(form.entries()));
        } catch (error) {
          alert(error.message);
        }
      }

      async function submitTaskDetailForm(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const form = new FormData(target);
        try {
          await updateTask(target.dataset.taskDetail, Object.fromEntries(form.entries()), state.selectedDetail?.projectId || state.activeProjectId);
        } catch (error) {
          alert(error.message);
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
        }
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
        await apiRequest(`api/people/${personId}`, {
          method: "PATCH",
          body: JSON.stringify(values)
        });
        state.selectedDetail = { type: "person", id: personId };
        state.saveNotice = { target: `person:${personId}`, message: "Persona guardada correctamente." };
        await refreshWorkspace();
      }

      async function updateProject(projectId, values) {
        await apiRequest(`api/projects/${projectId}`, {
          method: "PATCH",
          body: JSON.stringify(values)
        });
        state.activeProjectId = projectId;
        state.selectedDetail = { type: "project", id: projectId };
        state.saveNotice = { target: `project:${projectId}`, message: "Proyecto guardado correctamente." };
        await refreshWorkspace();
      }

      async function updateProjectMember(projectId, personId, values) {
        await apiRequest(`api/projects/${projectId}/members/${personId}`, {
          method: "PATCH",
          body: JSON.stringify(values)
        });
        state.activeProjectId = projectId;
        state.selectedDetail = { type: "project", id: projectId };
        await refreshWorkspace();
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
        await apiRequest(`api/projects/${projectId}/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify(values)
        });
        state.activeProjectId = projectId;
        if (showDetail) {
          state.saveNotice = { target: `task:${taskId}`, message: "Tarea guardada correctamente." };
          state.selectedDetail = { type: "task", id: taskId, projectId };
        }
        await refreshWorkspace();
      }

      async function refreshWorkspace() {
        state.workspace = null;
        await loadWorkspace();
        renderWorkspace();
      }

      function filterPeople(event) {
        const query = event.target.value.trim().toLowerCase();
        for (const card of document.querySelectorAll(".personCard")) {
          card.hidden = query && !card.textContent.toLowerCase().includes(query);
        }
      }

  return { render: renderWorkspace, refresh: refreshWorkspace };
}
