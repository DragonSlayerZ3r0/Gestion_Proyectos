      // @ts-nocheck
      import {
        CognitoIdentityProviderClient,
        InitiateAuthCommand,
        RespondToAuthChallengeCommand
      } from "@aws-sdk/client-cognito-identity-provider";
      import { createHomeModule } from "./modules/home";
      import { createAdminModule } from "./modules/admin";
      import { createWorkspaceModule } from "./modules/workspace";
      import { createCatalogModule } from "./modules/catalog";

      const defaultModules = [
        { key: "projects", label: "Proyectos y tareas" },
        { key: "home", label: "Inicio" },
        { key: "catalog", label: "Catálogo" },
        { key: "admin", label: "Administración" }
      ];

      const moduleOrder = ["projects", "home", "catalog", "admin"];

      const viewCopy = {
        home: {
          title: "Inicio",
          eyebrow: "Vista general",
          body: "Resumen operativo de proyectos, tareas y accesos habilitados.",
          metricLabel: "Elementos activos",
          metricValue: "5",
          items: ["Proyectos recientes", "Tareas asignadas", "Accesos disponibles"]
        },
        projects: {
          title: "Proyectos y tareas",
          eyebrow: "Gestión operativa",
          body: "Mesa de trabajo para registrar personas, crear proyectos y crear tareas sin cambiar de pantalla.",
          metricLabel: "Vista única",
          metricValue: "1",
          items: ["Personas registradas", "Proyectos activos", "Tareas por estado"]
        },
        tasks: {
          title: "Tareas",
          eyebrow: "Seguimiento",
          body: "Seguimiento simple de tareas por estado, prioridad y responsable.",
          metricLabel: "Estados base",
          metricValue: "4",
          items: ["Pendiente", "En progreso", "En revisión", "Completada"]
        },
        catalog: {
          title: "Catálogo",
          eyebrow: "Data Lake",
          body: "Exploración controlada de Glue Catalog con contexto funcional.",
          metricLabel: "Acceso",
          metricValue: "Controlado",
          items: ["Bases permitidas", "Tablas documentadas", "Preview limitado"]
        },
        admin: {
          title: "Administración",
          eyebrow: "Gobierno funcional",
          body: "Gestión inicial de usuarios, módulos habilitados y auditoría.",
          metricLabel: "Controles",
          metricValue: "3",
          items: ["Usuarios funcionales", "Módulos habilitados", "Auditoría"]
        }
      };

      const state = {
        config: null,
        authClient: null,
        authSession: null,
        authUsername: null,
        user: null,
        sessionExpiredHandled: false,
        sessionWatchdog: null,
        refreshPromise: null,
        profile: null,
        workspace: null,
        activeProjectId: null,
        selectedDetail: null,
        showPersonForm: false,
        showTaskForm: false,
        taskFormProjectId: null,
        projectStatusFilter: "all",
        projectSearch: "",
        personSearch: "",
        projectSearchScopes: {
          projects: true,
          tasks: true
        },
        expandedBoardProjectId: null,
        saveNotice: null,
        sidebarCollapsed: false,
        activeModule: "projects",
        catalogDatabases: [],
        catalogSelectedDb: null,
        catalogTables: [],
        catalogTablesLoading: false,
        catalogTablesError: "",
        adminUsers: [],
        adminModules: [],
        adminLoading: false,
        adminError: "",
        homeSummary: null,
        homeSummaryError: "",
        homeCosts: null,
        homeCostsError: "",
        homeCostsLoading: false,
        homeCostDetailService: null,
        homeCostDetail: null,
        homeCostDetailLoading: false,
        homeCostDetailError: "",
        homeDetailCollapsed: false,
        homeDailyCollapsed: false,
        homeCreditsCollapsed: false,
        homeDaily: null,
        homeDailyLoading: false,
        homeDailyError: "",
        homeDailyOpenDate: null,
        homeDailyDetailKey: null,
        homeDailyDetail: null,
        homeDailyDetailLoading: false,
        homeDailyDetailError: "",
        homeRespKey: null,
        homeResp: null,
        homeRespLoading: false,
        homeRespError: "",
        homeCostAccounts: null,
        homeCostAccount: "186281981036",
        homeCostPeriod: null,
        homeCostView: "net",
        homeTab: "resumen",
        homeCharts: {},
        ingestBucket: "arc-enterprise-data",
        ingestData: null,
        ingestScannedAt: null,
        ingestStatus: "empty",
        ingestScanning: false,
        ingestLoading: false,
        ingestError: "",
        ingestZone: null,
        ingestMetric: "count",
        ingestGroupBy: "area",
        ingestRangePreset: "90d",
        ingestRangeFrom: "",
        ingestRangeTo: "",
        ingestOpenArea: null,
        ingestOpenDay: null,
        ingestDetail: {},
        ingestDetailLoadingZone: null,
        ingestPollTimer: null,
        catalogSelectedTable: null,
        catalogSearch: "",
        catalogSearchScope: ["table"],
        catalogLoading: false,
        catalogSaving: false,
        catalogSyncedAt: null,
        catalogSyncStatus: null,
        catalogSyncPoller: null,
        catalogTableCache: {},
        needsNewPassword: false,
        loginBusy: false
      };

      const elements = {
        moduleNav: document.querySelector("#moduleNav"),
        app: document.querySelector("#app"),
        sidebarToggleButton: document.querySelector("#sidebarToggleButton"),
        loginLanding: document.querySelector("#loginLanding"),
        landingLoginButton: document.querySelector("#landingLoginButton"),
        loginLandingMessage: document.querySelector("#loginLandingMessage"),
        loginLandingEnvironment: document.querySelector("#loginLandingEnvironment"),
        loginButton: document.querySelector("#loginButton"),
        logoutButton: document.querySelector("#logoutButton"),
        userLabel: document.querySelector("#userLabel"),
        environmentLabel: document.querySelector("#environmentLabel"),
        statusPanel: document.querySelector("#statusPanel"),
        contentPanel: document.querySelector("#contentPanel"),
        viewTitle: document.querySelector("#viewTitle"),
        loginDialog: document.querySelector("#loginDialog"),
        loginForm: document.querySelector("#loginForm"),
        emailInput: document.querySelector("#emailInput"),
        passwordInput: document.querySelector("#passwordInput"),
        newPasswordFields: document.querySelector("#newPasswordFields"),
        newPasswordInput: document.querySelector("#newPasswordInput"),
        loginMessage: document.querySelector("#loginMessage"),
        submitLoginButton: document.querySelector("#submitLoginButton"),
        cancelLoginButton: document.querySelector("#cancelLoginButton"),
        cancelLoginIconButton: document.querySelector("#cancelLoginIconButton")
      };

      boot();

      async function boot() {
        renderDefaultNav();
        state.config = await loadConfig();
        elements.environmentLabel.textContent = state.config.environment || "dev";
        elements.loginLandingEnvironment.textContent = state.config.environment || "dev";

        if (!hasAuthConfig(state.config)) {
          renderLoginUnavailable("Falta completar la configuración de acceso.");
          return;
        }

        state.authClient = new CognitoIdentityProviderClient({
          region: state.config.region
        });

        elements.loginButton.addEventListener("click", openLoginDialog);
        elements.landingLoginButton.addEventListener("click", openLoginDialog);
        elements.logoutButton.addEventListener("click", logout);
        elements.sidebarToggleButton.addEventListener("click", toggleSidebar);
        elements.loginForm.addEventListener("submit", submitLogin);
        elements.cancelLoginButton.addEventListener("click", closeLoginDialog);
        elements.cancelLoginIconButton.addEventListener("click", closeLoginDialog);
        elements.loginDialog.addEventListener("click", (event) => {
          if (event.target === elements.loginDialog) {
            closeLoginDialog();
          }
        });

        state.user = await getCurrentSession();
        if (!state.user) {
          renderLoggedOut();
          return;
        }

        await loadMe();
      }

      async function loadConfig() {
        const response = await fetch("/config.json", { cache: "no-store" });
        return response.json();
      }

      function hasAuthConfig(config) {
        return Boolean(config.apiBaseUrl && config.region && config.cognitoUserPoolId && config.cognitoClientId);
      }

      function toggleSidebar() {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        elements.app.classList.toggle("sidebarCollapsed", state.sidebarCollapsed);
        elements.sidebarToggleButton.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
        elements.sidebarToggleButton.setAttribute("aria-label", state.sidebarCollapsed ? "Expandir menú" : "Contraer menú");
      }

      function normalizeModuleKey(key) {
        return key === "tasks" ? "projects" : key;
      }

      function getVisibleModules(modules = defaultModules) {
        const enabledModules = modules.filter((module) => module.enabled !== false);
        const hasProjectWorkspace = enabledModules.some((module) => module.key === "projects" || module.key === "tasks");
        const visibleByKey = new Map();

        if (hasProjectWorkspace) {
          visibleByKey.set("projects", {
            key: "projects",
            label: "Proyectos y tareas",
            enabled: true
          });
        }

        for (const module of enabledModules) {
          const key = normalizeModuleKey(module.key);
          if (key === "projects" || visibleByKey.has(key)) {
            continue;
          }
          visibleByKey.set(key, { ...module, key });
        }

        return Array.from(visibleByKey.values()).sort((left, right) => {
          const leftIndex = moduleOrder.indexOf(left.key);
          const rightIndex = moduleOrder.indexOf(right.key);
          return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
        });
      }

      function getDefaultModule(modules) {
        const visibleModules = getVisibleModules(modules);
        return visibleModules.some((module) => module.key === "projects") ? "projects" : visibleModules[0]?.key || "home";
      }

      async function loadMe() {
        const response = await fetch(`${state.config.apiBaseUrl}api/me`, {
          headers: {
            authorization: `Bearer ${state.user.idToken}`
          }
        });
        const payload = await response.json();

        if (!response.ok || !payload.ok) {
          renderStatus("Acceso pendiente", payload.error?.message || "No fue posible cargar tu perfil.");
          return;
        }

        state.profile = payload.data;
        const visibleModules = getVisibleModules(payload.data.modules);
        const savedModule = normalizeModuleKey(window.sessionStorage.getItem("gestionProyectosModule") || "");
        state.activeModule = visibleModules.some((module) => module.key === savedModule)
          ? savedModule
          : getDefaultModule(payload.data.modules);
        renderApp();
      }

      function getCurrentSession() {
        const rawSession = window.sessionStorage.getItem("gestionProyectosAuth");
        if (!rawSession) {
          return null;
        }

        try {
          const session = JSON.parse(rawSession);
          if (!session.idToken || !session.expiresAt || session.expiresAt <= Date.now()) {
            window.sessionStorage.removeItem("gestionProyectosAuth");
            return null;
          }
          return session;
        } catch {
          window.sessionStorage.removeItem("gestionProyectosAuth");
          return null;
        }
      }

      function openLoginDialog() {
        if (!state.authClient) {
          renderLoginUnavailable("La configuración de acceso todavía no está disponible.");
          return;
        }
        resetLoginForm();
        elements.loginDialog.hidden = false;
        elements.emailInput.focus();
      }

      function closeLoginDialog() {
        if (state.loginBusy) {
          return;
        }
        elements.loginDialog.hidden = true;
        resetLoginForm();
      }

      function resetLoginForm() {
        state.needsNewPassword = false;
        state.authSession = null;
        state.authUsername = null;
        state.loginBusy = false;
        elements.loginForm.reset();
        elements.newPasswordFields.hidden = true;
        elements.newPasswordInput.required = false;
        elements.passwordInput.disabled = false;
        elements.loginMessage.textContent = "";
        elements.loginMessage.className = "loginMessage";
        elements.submitLoginButton.textContent = "Ingresar";
        elements.submitLoginButton.disabled = false;
        elements.cancelLoginButton.disabled = false;
        elements.cancelLoginIconButton.disabled = false;
      }

      async function submitLogin(event) {
        event.preventDefault();
        if (state.loginBusy) {
          return;
        }

        if (state.needsNewPassword) {
          await completeNewPassword();
          return;
        }

        const email = elements.emailInput.value.trim().toLowerCase();
        const password = elements.passwordInput.value;
        if (!email || !password) {
          showLoginMessage("Ingresa tu correo y contraseña.", "error");
          return;
        }

        setLoginBusy(true, "Validando...");
        try {
          const response = await state.authClient.send(new InitiateAuthCommand({
            AuthFlow: "USER_PASSWORD_AUTH",
            ClientId: state.config.cognitoClientId,
            AuthParameters: {
              USERNAME: email,
              PASSWORD: password
            }
          }));

          if (response.ChallengeName === "NEW_PASSWORD_REQUIRED") {
            state.authSession = response.Session;
            state.authUsername = email;
            state.needsNewPassword = true;
            elements.newPasswordFields.hidden = false;
            elements.newPasswordInput.required = true;
            elements.passwordInput.disabled = true;
            elements.submitLoginButton.textContent = "Guardar contraseña";
            setLoginBusy(false);
            showLoginMessage("Cognito requiere definir una contraseña nueva para este usuario.", "info");
            elements.newPasswordInput.focus();
            return;
          }

          await finishLogin(response.AuthenticationResult);
        } catch (error) {
          setLoginBusy(false);
          showLoginMessage(formatAuthError(error), "error");
        }
      }

      async function completeNewPassword() {
        const newPassword = elements.newPasswordInput.value;
        if (!newPassword) {
          showLoginMessage("Ingresa una contraseña nueva.", "error");
          return;
        }

        setLoginBusy(true, "Guardando...");
        try {
          const response = await state.authClient.send(new RespondToAuthChallengeCommand({
            ChallengeName: "NEW_PASSWORD_REQUIRED",
            ClientId: state.config.cognitoClientId,
            Session: state.authSession,
            ChallengeResponses: {
              USERNAME: state.authUsername,
              NEW_PASSWORD: newPassword
            }
          }));
          await finishLogin(response.AuthenticationResult);
        } catch (error) {
          setLoginBusy(false);
          showLoginMessage(formatAuthError(error), "error");
        }
      }

      // Persiste el resultado de Cognito en state.user + sessionStorage.
      // refreshTokenFallback conserva el refreshToken previo cuando la respuesta
      // no trae uno nuevo (REFRESH_TOKEN_AUTH no devuelve refreshToken).
      function applyAuthResult(authenticationResult, refreshTokenFallback) {
        const expiresIn = authenticationResult.ExpiresIn || 3600;
        state.user = {
          accessToken: authenticationResult.AccessToken,
          idToken: authenticationResult.IdToken,
          refreshToken: authenticationResult.RefreshToken || refreshTokenFallback || null,
          expiresAt: Date.now() + expiresIn * 1000
        };
        window.sessionStorage.setItem("gestionProyectosAuth", JSON.stringify(state.user));
      }

      async function finishLogin(authenticationResult) {
        if (!authenticationResult?.IdToken) {
          setLoginBusy(false);
          showLoginMessage("Cognito no devolvió una sesión válida.", "error");
          return;
        }

        applyAuthResult(authenticationResult, null);
        elements.loginDialog.hidden = true;
        resetLoginForm();
        await loadMe();
      }

      function logout(sessionExpired) {
        window.sessionStorage.removeItem("gestionProyectosAuth");
        window.sessionStorage.removeItem("gestionProyectosModule");
        state.user = null;
        state.profile = null;
        state.workspace = null;
        state.activeProjectId = null;
        state.selectedDetail = null;
        state.showPersonForm = false;
        state.showTaskForm = false;
        clearSessionWatchdog();
        state.activeModule = getDefaultModule(defaultModules);
        renderDefaultNav();
        renderLoggedOut(sessionExpired === true);
      }

      // Sesión Cognito expirada: el idToken venció (o la API respondió 401).
      // En lugar de dejar la pantalla congelada sin funcionalidad, regresamos
      // al login con un aviso claro. Idempotente ante múltiples llamadas en
      // paralelo (varias peticiones pueden fallar a la vez).
      function handleSessionExpired() {
        if (state.sessionExpiredHandled) return;
        state.sessionExpiredHandled = true;
        logout(true);
      }

      // Margen para renovar el idToken antes de que venza (5 min). Si quedan
      // menos de estos ms, se intenta refrescar usando el refreshToken.
      const SESSION_REFRESH_MARGIN_MS = 5 * 60 * 1000;

      // Renovación silenciosa: intercambia el refreshToken (válido más tiempo)
      // por un idToken nuevo, sin sacar al usuario de la pantalla. Devuelve
      // true si la sesión quedó vigente. Deduplica llamadas concurrentes con
      // una promesa compartida.
      function refreshSession() {
        if (state.refreshPromise) return state.refreshPromise;
        if (!state.user || !state.user.refreshToken || !state.authClient) {
          return Promise.resolve(false);
        }
        const refreshToken = state.user.refreshToken;
        state.refreshPromise = (async () => {
          try {
            const response = await state.authClient.send(new InitiateAuthCommand({
              AuthFlow: "REFRESH_TOKEN_AUTH",
              ClientId: state.config.cognitoClientId,
              AuthParameters: { REFRESH_TOKEN: refreshToken }
            }));
            if (!response.AuthenticationResult?.IdToken) return false;
            applyAuthResult(response.AuthenticationResult, refreshToken);
            scheduleSessionWatchdog();
            return true;
          } catch {
            // refreshToken vencido/revocado: no se puede renovar.
            return false;
          } finally {
            state.refreshPromise = null;
          }
        })();
        return state.refreshPromise;
      }

      // Garantiza un idToken utilizable antes de llamar a la API. Si está por
      // vencer (o ya venció) intenta renovarlo silenciosamente.
      async function ensureFreshToken() {
        if (!state.user || !state.user.idToken || !state.user.expiresAt) return false;
        if (state.user.expiresAt - Date.now() > SESSION_REFRESH_MARGIN_MS) return true;
        return refreshSession();
      }

      // Watchdog: programa la renovación ~5 min antes del vencimiento. Si la
      // renovación falla (refreshToken también vencido) o el usuario lleva
      // demasiado tiempo inactivo, regresa al login en lugar de dejar la
      // pantalla congelada.
      function clearSessionWatchdog() {
        if (state.sessionWatchdog) {
          window.clearTimeout(state.sessionWatchdog);
          state.sessionWatchdog = null;
        }
      }

      function scheduleSessionWatchdog() {
        clearSessionWatchdog();
        if (!state.user || !state.user.expiresAt) return;
        const msLeft = state.user.expiresAt - Date.now();
        if (msLeft <= 0) {
          handleSessionExpired();
          return;
        }
        // Despierta con margen para renovar; si ya estamos dentro del margen,
        // intenta renovar de inmediato (pero no antes de 1 s).
        const fireIn = Math.max(1000, msLeft - SESSION_REFRESH_MARGIN_MS);
        state.sessionWatchdog = window.setTimeout(async () => {
          const ok = await refreshSession();
          if (!ok) handleSessionExpired();
        }, fireIn);
      }

      function setLoginBusy(isBusy, label) {
        state.loginBusy = isBusy;
        elements.submitLoginButton.disabled = isBusy;
        elements.cancelLoginButton.disabled = isBusy;
        elements.cancelLoginIconButton.disabled = isBusy;
        if (label) {
          elements.submitLoginButton.textContent = label;
        } else if (state.needsNewPassword) {
          elements.submitLoginButton.textContent = "Guardar contraseña";
        } else {
          elements.submitLoginButton.textContent = "Ingresar";
        }
      }

      function showLoginMessage(message, type) {
        elements.loginMessage.textContent = message;
        elements.loginMessage.className = `loginMessage ${type || ""}`.trim();
      }

      function formatAuthError(error) {
        const code = error?.code || error?.name;
        if (code === "NotAuthorizedException") {
          return "El correo o la contraseña no son correctos.";
        }
        if (code === "UserNotFoundException") {
          return "El usuario no existe en Cognito.";
        }
        if (code === "PasswordResetRequiredException") {
          return "El usuario requiere restablecer su contraseña.";
        }
        if (code === "InvalidPasswordException") {
          return "La contraseña nueva no cumple la política definida en Cognito.";
        }
        return error?.message || "No fue posible iniciar sesión.";
      }

      function renderLoggedOut(sessionExpired) {
        elements.app.classList.add("loginOnly");
        elements.loginLanding.hidden = false;
        elements.landingLoginButton.disabled = false;
        elements.loginLandingMessage.textContent = sessionExpired
          ? "Tu sesión expiró por seguridad. Inicia sesión de nuevo para continuar."
          : "Tus módulos y permisos se cargan después de validar tu identidad.";
        elements.loginLandingMessage.classList.toggle("loginLandingMessageWarn", sessionExpired === true);
        elements.contentPanel.hidden = true;
        elements.statusPanel.hidden = true;
        elements.loginButton.hidden = false;
        elements.logoutButton.hidden = true;
        elements.userLabel.textContent = "Sin sesión";
      }

      function renderApp() {
        state.sessionExpiredHandled = false;
        scheduleSessionWatchdog();
        elements.app.classList.remove("loginOnly");
        elements.loginLanding.hidden = true;
        elements.loginButton.hidden = true;
        elements.logoutButton.hidden = false;
        elements.userLabel.textContent = state.profile.user.email;
        elements.environmentLabel.textContent = state.profile.environment;
        renderNav();
        renderModule(state.activeModule);
      }

      function renderNav() {
        elements.moduleNav.innerHTML = "";
        const visibleModules = getVisibleModules(state.profile.modules);
        state.activeModule = normalizeModuleKey(state.activeModule);
        if (!visibleModules.some((module) => module.key === state.activeModule)) {
          state.activeModule = getDefaultModule(visibleModules);
        }

        for (const module of visibleModules) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = module.label;
          button.className = module.key === state.activeModule ? "navItem active" : "navItem";
          button.addEventListener("click", () => {
            state.activeModule = module.key;
            window.sessionStorage.setItem("gestionProyectosModule", module.key);
            renderApp();
          });
          elements.moduleNav.append(button);
        }
      }

      function renderDefaultNav() {
        elements.moduleNav.innerHTML = "";
        const activeModule = getDefaultModule(defaultModules);
        for (const module of getVisibleModules(defaultModules)) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = module.label;
          button.className = module.key === activeModule ? "navItem active" : "navItem muted";
          button.setAttribute("aria-disabled", "true");
          elements.moduleNav.append(button);
        }
      }

      // Módulo Inicio extraído a su propio archivo (patrón de módulos enchufables).
      // Recibe el estado y los helpers compartidos por inyección de dependencias.
      const homeModule = createHomeModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes, catalogSyncedLabel,
      });
      const adminModule = createAdminModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton,
      });
      const workspaceModule = createWorkspaceModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, priorityLabel,
      });
      const catalogModule = createCatalogModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes, catalogSyncedLabel, catalogDateLabel,
      });

      function renderModule(moduleKey) {
        moduleKey = normalizeModuleKey(moduleKey);
        if (moduleKey === "projects" || moduleKey === "tasks") {
          workspaceModule.render();
          return;
        }
        if (moduleKey === "catalog") {
          catalogModule.render();
          return;
        }
        if (moduleKey === "admin") {
          adminModule.render();
          return;
        }
        if (moduleKey === "home") {
          homeModule.render();
          return;
        }

        const copy = viewCopy[moduleKey] || viewCopy.home;
        const items = copy.items.map((item) => `<li>${item}</li>`).join("");
        elements.statusPanel.hidden = true;
        elements.contentPanel.hidden = false;
        elements.contentPanel.className = "contentGrid";
        elements.viewTitle.textContent = copy.title;
        elements.contentPanel.innerHTML = `
          <article class="panel modulePanel">
            <p class="eyebrow">${copy.eyebrow}</p>
            <div class="panelHeader">
              <div>
                <h2>${copy.title}</h2>
                <p>${copy.body}</p>
              </div>
              <div class="metric">
                <strong>${copy.metricValue}</strong>
                <span>${copy.metricLabel}</span>
              </div>
            </div>
            <ul class="workList">${items}</ul>
          </article>
          <article class="panel profilePanel">
            <h2>Perfil</h2>
            <dl>
              <div><dt>Usuario</dt><dd>${state.profile.user.email}</dd></div>
              <div><dt>Perfiles</dt><dd>${state.profile.user.roles.join(", ")}</dd></div>
              <div><dt>Ambiente</dt><dd>${state.profile.environment}</dd></div>
            </dl>
          </article>
          <article class="panel actionPanel">
            <h2>Siguientes acciones</h2>
            <ul class="workList">
              <li>Validar el primer inicio de sesión con Cognito.</li>
              <li>Confirmar módulos visibles según permisos.</li>
              <li>Priorizar el primer flujo operativo.</li>
            </ul>
          </article>
        `;
      }


      async function apiRequest(path, options = {}) {
        // Si el token está por vencer, intenta renovarlo antes de la llamada.
        if (!(await ensureFreshToken())) {
          handleSessionExpired();
          throw new Error("Tu sesión expiró. Inicia sesión de nuevo.");
        }
        let response = await fetch(`${state.config.apiBaseUrl}${path}`, {
          ...options,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${state.user.idToken}`,
            ...(options.headers || {})
          }
        });
        // El authorizer rechazó el JWT: un último intento de renovar y reintentar.
        if (response.status === 401) {
          if (await refreshSession()) {
            response = await fetch(`${state.config.apiBaseUrl}${path}`, {
              ...options,
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${state.user.idToken}`,
                ...(options.headers || {})
              }
            });
          }
          if (response.status === 401) {
            handleSessionExpired();
            throw new Error("Tu sesión expiró. Inicia sesión de nuevo.");
          }
        }
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error?.message || "No fue posible completar la acción.");
        }
        return payload;
      }


      // ── Catálogo ─────────────────────────────────────────────────────────────

      function catalogSyncedLabel(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        const diffMs = Date.now() - d.getTime();
        const diffH = Math.floor(diffMs / 3600000);
        const diffM = Math.floor(diffMs / 60000);
        if (diffM < 1) return "Ahora mismo";
        if (diffM < 60) return `Hace ${diffM} min`;
        if (diffH < 24) return `Hace ${diffH} h`;
        return `Hace ${Math.floor(diffH / 24)} días`;
      }

      function catalogDateLabel(iso) {
        if (!iso) return "—";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "—";
        return d.toLocaleDateString("es-GT", { year: "numeric", month: "2-digit", day: "2-digit" });
      }

      function formatBytes(n) {
        if (!n || n < 0) return "0 B";
        const u = ["B", "KB", "MB", "GB", "TB", "PB"];
        let i = 0;
        let v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
      }


      // ─────────────────────────────────────────────────────────────────────────

      function priorityLabel(priority) {
        const labels = {
          low: "Baja",
          medium: "Media",
          high: "Alta",
          critical: "Crítica"
        };
        return labels[priority] || "";
      }

      function renderEditIconButton(label, attributes) {
        return `
          <button class="iconTinyButton" type="button" ${attributes} aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 20h4.5L19 9.5 14.5 5 4 15.5V20z"></path>
              <path d="M13.5 6 18 10.5"></path>
            </svg>
          </button>
        `;
      }

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      function escapeAttribute(value) {
        return escapeHtml(value);
      }

      function renderStatus(title, message) {
        elements.app.classList.remove("loginOnly");
        elements.loginLanding.hidden = true;
        elements.statusPanel.hidden = false;
        elements.contentPanel.hidden = true;
        elements.contentPanel.className = "contentGrid";
        elements.viewTitle.textContent = title;
        elements.statusPanel.innerHTML = `
          <div class="statusPending">
            <p class="eyebrow">Plataforma interna</p>
            <h2>${title}</h2>
            <p>${message}</p>
            <p class="statusPendingHint">Tu cuenta inició sesión correctamente, pero todavía no tiene accesos asignados. Solicita a un administrador que te habilite, o vuelve a iniciar sesión con otra cuenta.</p>
            <button id="statusBackButton" class="primaryButton" type="button">Volver e iniciar sesión de nuevo</button>
          </div>
        `;
        const backButton = elements.statusPanel.querySelector("#statusBackButton");
        if (backButton) backButton.addEventListener("click", logout);
      }

      function renderLoginUnavailable(message) {
        elements.app.classList.add("loginOnly");
        elements.loginLanding.hidden = false;
        elements.statusPanel.hidden = true;
        elements.contentPanel.hidden = true;
        elements.loginButton.hidden = true;
        elements.logoutButton.hidden = true;
        elements.userLabel.textContent = "Sin sesión";
        elements.landingLoginButton.disabled = true;
        elements.loginLandingMessage.textContent = message;
      }
