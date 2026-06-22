// @ts-nocheck
// Módulo Administración de usuarios. Inyección de dependencias desde el shell.
export function createAdminModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute } = ctx;

      async function renderAdmin() {
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
        } catch (err) {
          state.adminError = err?.message || "No se pudieron cargar los usuarios.";
        }
        state.adminLoading = false;
        paintAdmin();
      }

      // Grupos visibles de módulos. "Proyectos y tareas" es un solo módulo para el
      // usuario, aunque internamente son dos claves (projects + tasks) que van juntas.
      const adminModuleGroups = [
        { key: "home", label: "Inicio", keys: ["home"] },
        { key: "projects", label: "Proyectos y tareas", keys: ["projects", "tasks"] },
        { key: "catalog", label: "Catálogo", keys: ["catalog"] },
        { key: "admin", label: "Administración", keys: ["admin"] },
      ];

      function adminModuleCheckboxes(prefix, selected) {
        const set = new Set(selected || []);
        return adminModuleGroups.map((g) => {
          const checked = g.keys.some((k) => set.has(k));
          return `
          <label class="adminModuleChk">
            <input type="checkbox" data-mod="${escapeAttribute(g.key)}" name="${prefix}-mod"
              ${checked ? "checked" : ""} ${g.key === "home" ? "disabled checked" : ""} />
            <span>${escapeHtml(g.label)}</span>
          </label>`;
        }).join("");
      }

      // Expande las casillas marcadas (por grupo) a las claves reales de módulo.
      function adminExpandSelectedModules(container, selector) {
        const groupKeys = [...container.querySelectorAll(selector)].map((c) => c.dataset.mod);
        const result = new Set();
        for (const gk of groupKeys) {
          const group = adminModuleGroups.find((g) => g.key === gk);
          (group ? group.keys : [gk]).forEach((k) => result.add(k));
        }
        return [...result];
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
          : state.adminUsers.map((u) => `
            <div class="adminUserCard" data-email="${escapeAttribute(u.email)}">
              <div class="adminUserHead">
                <div>
                  <strong>${escapeHtml(u.name || u.email)}</strong>
                  <span class="adminUserEmail">${escapeHtml(u.email)}</span>
                </div>
                <span class="adminStatusBadge ${u.status === "active" ? "on" : "off"}">${u.status === "active" ? "Activo" : "Inactivo"}</span>
              </div>
              <div class="adminUserControls">
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
              <div class="adminUserActions">
                <button class="dangerButton adminDeleteUser" type="button">Eliminar</button>
                <button class="primaryButton adminSaveUser" type="button">Guardar cambios</button>
              </div>
            </div>`).join("");

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
                ${adminModuleCheckboxes("new", ["home", "catalog"])}
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

        elements.contentPanel.querySelectorAll(".adminSaveUser").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const card = btn.closest(".adminUserCard");
            const email = card.dataset.email;
            const modules = adminExpandSelectedModules(card, "[name=edit-mod]:checked");
            const body = {
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

        elements.contentPanel.querySelectorAll(".adminDeleteUser").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const card = btn.closest(".adminUserCard");
            const email = card.dataset.email;
            if (!window.confirm(`¿Eliminar al usuario "${email}"? Se borra su perfil y todos sus accesos. Esta acción no se puede deshacer.`)) return;
            btn.disabled = true;
            btn.textContent = "Eliminando…";
            try {
              await apiRequest(`api/admin/users/${encodeURIComponent(email)}`, { method: "DELETE" });
              await renderAdmin();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = "Eliminar";
              window.alert(err?.message || "No se pudo eliminar el usuario.");
            }
          });
        });
      }

  return { render: renderAdmin };
}
