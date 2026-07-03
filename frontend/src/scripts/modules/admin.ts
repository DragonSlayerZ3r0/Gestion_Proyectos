// @ts-nocheck
// Módulo Administración de usuarios. Inyección de dependencias desde el shell.
export function createAdminModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton } = ctx;

      // Email de la tarjeta abierta en modo edición; null = todas colapsadas.
      let editingEmail = null;

      // Ícono de eliminar (papelera), homólogo a renderEditIconButton del shell.
      function renderDeleteIconButton(label, attributes) {
        return `
          <button class="iconTinyButton iconTinyDanger" type="button" ${attributes} aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 7h16"></path>
              <path d="M9 7V5h6v2"></path>
              <path d="M6 7l1 13h10l1-13"></path>
              <path d="M10 11v6M14 11v6"></path>
            </svg>
          </button>
        `;
      }

      async function renderAdmin() {
        editingEmail = null;
        elements.statusPanel.hidden = true;
        elements.contentPanel.hidden = false;
        elements.contentPanel.className = "contentGrid adminGrid";
        elements.viewTitle.textContent = "Administración";
        state.adminLoading = true;
        state.adminError = "";
        paintAdmin();
        try {
          const payload = await apiRequest("api/admin/users");
          state.adminUsers = payload.data.users || [];
          state.adminModules = payload.data.availableModules || [];
          // Matriz de asignación derivada del manifiesto backend (fuente única):
          // módulos/pestañas nuevos aparecen solos, sin tocar este archivo.
          state.adminModuleGroups = payload.data.moduleGroups || null;
          state.adminDefaultNewUserKeys = payload.data.defaultNewUserKeys || null;
        } catch (err) {
          state.adminError = err?.message || "No se pudieron cargar los usuarios.";
        }
        state.adminLoading = false;
        paintAdmin();
      }

      // Matriz de asignación: la fuente única es el MANIFIESTO backend
      // (modules/manifest.py → admin_module_groups, vía GET /api/admin/users).
      // Este fallback local existe SOLO para un bundle viejo contra un backend
      // que aún no exponga moduleGroups — no se mantiene: los módulos/pestañas
      // nuevos se agregan en el manifiesto, no aquí.
      const fallbackModuleGroups = [
        {
          key: "home", label: "Panel", keys: ["home"], locked: true,
          children: [
            { key: "home_resumen", label: "Resumen" },
            { key: "home_datalake", label: "Data Lake" },
            { key: "home_facturacion", label: "Facturación" },
            { key: "home_athena", label: "Athena" },
          ],
        },
        { key: "projects", label: "Proyectos y tareas", keys: ["projects", "tasks"] },
        { key: "catalog", label: "Catálogo", keys: ["catalog"] },
        { key: "chat", label: "Apoyo técnico", keys: ["chat"] },
        { key: "admin", label: "Administración", keys: ["admin"] },
      ];

      function adminModuleGroups() {
        return state.adminModuleGroups || fallbackModuleGroups;
      }

      function adminModuleCheckboxes(prefix, selected) {
        const set = new Set(selected || []);
        return adminModuleGroups().map((g) => {
          const checked = g.keys.some((k) => set.has(k));
          const children = (g.children || []).map((c) => `
            <label class="adminModuleChk adminModuleChild">
              <input type="checkbox" data-mod="${escapeAttribute(c.key)}" name="${prefix}-mod"
                ${set.has(c.key) ? "checked" : ""} />
              <span>${escapeHtml(c.label)}</span>
            </label>`).join("");
          return `
          <div class="adminModuleGroup">
            <label class="adminModuleChk">
              <input type="checkbox" data-mod="${escapeAttribute(g.key)}" name="${prefix}-mod"
                ${checked ? "checked" : ""} ${g.locked ? "disabled checked" : ""} />
              <span>${escapeHtml(g.label)}</span>
            </label>
            ${children ? `<div class="adminModuleChildren">${children}</div>` : ""}
          </div>`;
        }).join("");
      }

      // Expande las casillas marcadas a las claves reales de módulo. Las casillas
      // de grupo se expanden a sus keys; las hijas (pestañas) se toman tal cual.
      function adminExpandSelectedModules(container, selector) {
        const checkedKeys = [...container.querySelectorAll(selector)].map((c) => c.dataset.mod);
        const result = new Set();
        for (const ck of checkedKeys) {
          const group = adminModuleGroups().find((g) => g.key === ck);
          (group ? group.keys : [ck]).forEach((k) => result.add(k));
        }
        return [...result];
      }

      // Resumen legible de los módulos habilitados (por grupo) para la vista colapsada.
      function moduleSummary(modules) {
        const set = new Set(modules || []);
        const labels = adminModuleGroups()
          .filter((g) => g.keys.some((k) => set.has(k)))
          .map((g) => g.label);
        return labels.length ? labels.join(" · ") : "Sin módulos";
      }

      function adminUserCard(u) {
        const roleLabel = u.role === "admin" ? "Administrador" : "Usuario";
        const isEditing = editingEmail === u.email;
        const editBody = isEditing ? `
              <div class="adminUserControls">
                <label class="adminNameLabel">Nombre
                  <input type="text" name="name" value="${escapeAttribute(u.name && u.name !== u.email ? u.name : "")}" placeholder="Nombre visible" />
                </label>
                <label>Rol
                  <select name="role">
                    <option value="user" ${u.role === "user" ? "selected" : ""}>Usuario</option>
                    <option value="admin" ${u.role === "admin" ? "selected" : ""}>Administrador</option>
                  </select>
                </label>
                <label>Estado
                  <select name="status">
                    <option value="active" ${u.status === "active" ? "selected" : ""}>Activo</option>
                    <option value="inactive" ${u.status === "inactive" ? "selected" : ""}>Inactivo</option>
                  </select>
                </label>
              </div>
              <div class="adminModules">${adminModuleCheckboxes("edit", u.modules)}</div>
              <div class="adminEditActions">
                ${renderDeleteIconButton("Eliminar usuario", 'data-action="delete"')}
                <div class="adminEditActionsRight">
                  <button class="secondaryButton adminCancelEdit" type="button">Cancelar</button>
                  <button class="primaryButton adminSaveUser" type="button">Guardar cambios</button>
                </div>
              </div>` : `
              <p class="adminUserSummary">${escapeHtml(roleLabel)} · ${escapeHtml(moduleSummary(u.modules))}</p>`;
        return `
            <div class="adminUserCard${isEditing ? " editing" : ""}" data-email="${escapeAttribute(u.email)}">
              <div class="adminUserHead">
                <div>
                  <strong>${escapeHtml(u.name || u.email)}</strong>
                  <span class="adminUserEmail">${escapeHtml(u.email)}</span>
                </div>
                <div class="adminUserHeadRight">
                  <span class="adminStatusBadge ${u.status === "active" ? "on" : "off"}">${u.status === "active" ? "Activo" : "Inactivo"}</span>
                  ${isEditing ? "" : renderEditIconButton("Editar usuario", 'data-action="edit"')}
                </div>
              </div>${editBody}
            </div>`;
      }

      function paintAdmin() {
        const isAdmin = (state.profile?.user?.roles || []).includes("admin");
        if (!isAdmin) {
          elements.contentPanel.innerHTML = `<article class="panel"><p class="catalogEmpty catalogEmptyError">No tienes permiso para administrar usuarios.</p></article>`;
          return;
        }

        const rows = state.adminLoading
          ? `<p class="catalogEmpty">Cargando usuarios…</p>`
          : state.adminError
          ? `<p class="catalogEmpty catalogEmptyError">${escapeHtml(state.adminError)}</p>`
          : !state.adminUsers.length
          ? `<p class="catalogEmpty">No hay usuarios configurados todavía.</p>`
          : state.adminUsers.map(adminUserCard).join("");

        elements.contentPanel.innerHTML = `
          <article class="panel adminListPanel">
            <div class="panelHeader">
              <div><p class="eyebrow">Gobierno funcional</p><h2>Usuarios</h2>
              <p>Gestiona el acceso funcional: rol, estado y módulos visibles. El usuario debe existir antes en Cognito.</p></div>
            </div>
            <div class="adminUserList">${rows}</div>
          </article>
          <article class="panel adminFormPanel">
            <h2>Nuevo usuario</h2>
            <p class="adminHint">El email debe coincidir con el creado en Cognito.</p>
            <form class="adminCreateForm">
              <label>Email
                <input type="email" name="email" required placeholder="usuario@banrural.com.gt" />
              </label>
              <label>Nombre
                <input type="text" name="name" placeholder="Nombre visible (opcional)" />
              </label>
              <label>Rol
                <select name="role">
                  <option value="user" selected>Usuario</option>
                  <option value="admin">Administrador</option>
                </select>
              </label>
              <fieldset class="adminModules">
                <legend>Módulos</legend>
                ${adminModuleCheckboxes("new", state.adminDefaultNewUserKeys || ["home", "home_resumen", "home_datalake", "catalog"])}
              </fieldset>
              <button class="primaryButton" type="submit">Crear usuario</button>
              <p class="adminFormMsg" hidden></p>
            </form>
          </article>`;

        bindAdminEvents();
      }

      function bindAdminEvents() {
        const form = elements.contentPanel.querySelector(".adminCreateForm");
        if (form) {
          form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const msg = form.querySelector(".adminFormMsg");
            const modules = adminExpandSelectedModules(form, "[name=new-mod]:checked");
            const body = {
              email: form.email.value.trim(),
              name: form.name.value.trim(),
              role: form.role.value,
              modules,
            };
            const btn = form.querySelector("button[type=submit]");
            btn.disabled = true;
            try {
              await apiRequest("api/admin/users", { method: "POST", body: JSON.stringify(body) });
              await renderAdmin();
            } catch (err) {
              msg.hidden = false;
              msg.className = "adminFormMsg error";
              msg.textContent = err?.message || "No se pudo crear el usuario.";
              btn.disabled = false;
            }
          });
        }

        // Abrir edición (ícono de lápiz): colapsa cualquier otra y repinta.
        elements.contentPanel.querySelectorAll('.adminEditUser, [data-action="edit"]').forEach((btn) => {
          btn.addEventListener("click", () => {
            const card = btn.closest(".adminUserCard");
            editingEmail = card.dataset.email;
            paintAdmin();
          });
        });

        // Cancelar edición: vuelve a la vista colapsada sin guardar.
        elements.contentPanel.querySelectorAll(".adminCancelEdit").forEach((btn) => {
          btn.addEventListener("click", () => {
            editingEmail = null;
            paintAdmin();
          });
        });

        elements.contentPanel.querySelectorAll(".adminSaveUser").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const card = btn.closest(".adminUserCard");
            const email = card.dataset.email;
            const modules = adminExpandSelectedModules(card, "[name=edit-mod]:checked");
            const body = {
              name: card.querySelector("[name=name]").value.trim(),
              role: card.querySelector("[name=role]").value,
              status: card.querySelector("[name=status]").value,
              modules,
            };
            btn.disabled = true;
            btn.textContent = "Guardando…";
            try {
              await apiRequest(`api/admin/users/${encodeURIComponent(email)}`, { method: "PATCH", body: JSON.stringify(body) });
              await renderAdmin();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = "Reintentar";
              window.alert(err?.message || "No se pudo actualizar el usuario.");
            }
          });
        });

        elements.contentPanel.querySelectorAll('.adminDeleteUser, [data-action="delete"]').forEach((btn) => {
          btn.addEventListener("click", async () => {
            const card = btn.closest(".adminUserCard");
            const email = card.dataset.email;
            if (!window.confirm(`¿Eliminar al usuario "${email}"? Se borra su perfil y todos sus accesos. Esta acción no se puede deshacer.`)) return;
            btn.disabled = true;
            try {
              await apiRequest(`api/admin/users/${encodeURIComponent(email)}`, { method: "DELETE" });
              await renderAdmin();
            } catch (err) {
              btn.disabled = false;
              window.alert(err?.message || "No se pudo eliminar el usuario.");
            }
          });
        });
      }

  return { render: renderAdmin };
}
