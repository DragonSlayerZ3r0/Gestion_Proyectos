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
      import { createChatModule } from "./modules/chat";
      import { createDrawModule } from "./modules/draw";
      import { createStaffModule } from "./modules/staff";

      const defaultModules = [
        { key: "projects", label: "Solicitudes" },
        { key: "home", label: "Panel" },
        { key: "catalog", label: "Catálogo" },
        { key: "chat", label: "Apoyo técnico" },
        { key: "admin", label: "Administración" }
      ];

      const moduleOrder = ["projects", "home", "catalog", "chat", "admin"];

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
        projectSearchScope: "all",  // alcance de la búsqueda: "all" | "projects" | "tasks"
        workspaceView: "manage",    // vista de Solicitudes: "manage" (Gestión) | "board" (Tablero de avance)
        boardExpanded: null,        // solicitud expandida en el tablero (qué falta / cuándo)
        expandedBoardProjectId: null,
        peopleSectionOpen: false,  // sección "Personas registradas" colapsada por defecto
        projectSort: null,         // orden de la tabla de solicitudes {key, dir}; null = orden del backend
        projectColOrder: null,     // orden de COLUMNAS preferido por el usuario (localStorage); null = el del código
        updateEditing: null,    // {projectId, updateId} entrada de seguimiento en edición
        updatesExpanded: {},    // por projectId: true = mostrar todo el seguimiento (no solo lo último)
        attachQueryFor: null,   // projectId con el formulario "+ Query" abierto (o null)
        attachUploading: {},    // por projectId: true mientras sube un archivo
        attachError: {},        // por projectId: mensaje de error de la última subida
        attachNoteFor: null,    // "projectId:attachmentId" con el form "+ Nueva nota" abierto
        drawData: null,         // pizarras del usuario {mine, shared, invitations} (null = sin cargar)
        drawError: "",
        drawView: "list",       // "list" | "editor"
        drawActive: null,       // pizarra abierta en el editor
        drawPeople: null,       // usuarios para el selector "Compartir con" (carga perezosa)
        drawShareOpen: false,   // panel Compartir visible en el editor
        staffData: null,        // Personal: {people, absenceTypes} (null = sin cargar)
        staffError: "",
        staffMonth: "",         // mes del calendario "AAAA-MM" ("" = mes actual)
        staffSelectedId: null,  // persona con la ficha abierta
        staffSearch: "",        // filtro de la lista/calendario de Personal
        staffFormOpen: false,   // formulario "Registrar ausencia" visible (admin)
        staffQuotaOpen: false,  // formulario de cuota anual visible (admin, secundario)
        staffNotesOpen: false,  // formulario de nota de Personal visible (admin)
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
        athenaData: null,
        athenaStatus: "empty",
        athenaScannedAt: null,
        athenaScanning: false,
        athenaError: "",
        athenaLoading: false,
        athenaRangeDays: 7,
        athenaPollTimer: null,
        athenaOpenQid: null,
        athenaSqlCache: {},
        athenaSort: { key: "bytes", dir: -1 },
        athenaCols: { queries: true, bytes: true, costo: true, totalMs: true, maxMs: true, antipatterns: true },
        athenaOpenUser: null,
        athenaUserAp: {},
        athenaUserFilter: "",
        athenaMarkOff: {},   // antipatrones "desmarcados" (quitados del resaltado en el query)
        athenaOpenInfo: {},  // recomendación desplegada (independiente del resaltado)
        athenaApSort: "bytes",
        athenaApSortDir: "desc",
        athenaApFilter: "",
        athenaInfoOpen: false,
        athenaLlmSuggest: {},  // sugerencia del LLM por qid: {loading, text, error}
        chatSessions: null,        // lista de conversaciones guardadas (null = sin cargar aún)
        chatSessionsLoading: false,
        chatActiveSessionId: null, // null = conversación nueva (sin crear todavía)
        chatMessages: {},          // por sessionId: [{role, text, createdAt}]
        chatMessagesLoading: {},   // por sessionId: bool (carga de historial)
        chatSending: false,     // POST en vuelo (breve: solo encola)
        chatGenerating: {},     // por sessionId: true mientras el worker genera la respuesta
        chatDetected: {},       // por sessionId: antipatrones detectados al enviar (se muestran mientras genera)
        chatError: "",
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
        ingestRecords: {},
        ingestRecordsPollTimer: null,
        ingestDayTables: {},
        ingestOpenDayArea: null,
        ingestOpenFiles: {},
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
        staffMenuButton: document.querySelector("#staffMenuButton"),
        userMenu: document.querySelector("#userMenu"),
        userMenuButton: document.querySelector("#userMenuButton"),
        userMenuDropdown: document.querySelector("#userMenuDropdown"),
        userLabel: document.querySelector("#userLabel"),
        userEmailLabel: document.querySelector("#userEmailLabel"),
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
        // "Personal" (gestión del equipo): vista ocasional, se abre desde el menú
        // del usuario — NO es un módulo del menú lateral (decisión 2026-07-07).
        elements.staffMenuButton.addEventListener("click", () => {
          setUserMenuOpen(false);
          const changed = state.activeModule !== "staff";
          state.activeModule = "staff";
          renderApp();
          if (changed) animateViewEnter();
        });
        elements.userMenuButton.addEventListener("click", (event) => {
          event.stopPropagation();
          setUserMenuOpen(elements.userMenuDropdown.hidden);
        });
        document.addEventListener("click", (event) => {
          if (!elements.userMenu.hidden && !elements.userMenu.contains(event.target)) {
            setUserMenuOpen(false);
          }
        });
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape") setUserMenuOpen(false);
        });
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
        startDeployWatch();
        if (!state.user) {
          renderLoggedOut();
          return;
        }

        await loadMe();
        playBrandWelcome();
      }

      async function loadConfig() {
        const response = await fetch("/config.json", { cache: "no-store" });
        return response.json();
      }

      // ── Aviso de despliegue en curso ─────────────────────────────────────
      // Los scripts de deploy suben /deploy.json (status deploying|ok, ver
      // scripts/deploy-flag.sh). Aquí se consulta cada 20s: mientras haya un
      // despliegue activo se muestra un aviso discreto e intermitente para que
      // los usuarios no guarden cambios justo en ese momento; cuando termina y
      // el buildId cambió, se sugiere recargar. Archivo estático vía CloudFront
      // → costo cero en Lambda. Banderas huérfanas (>30 min) se ignoran.
      // El sondeo de 20s va emparejado con el dwell mínimo del aviso en
      // deploy-flag.sh (~25s): así incluso un deploy de frontend rápido (~15s)
      // deja la ventana "desplegando" abierta lo suficiente para que un sondeo la
      // atrape (antes, con 60s, los deploys rápidos se la saltaban).
      const DEPLOY_POLL_MS = 20 * 1000;
      let deployBaselineBuildId = null;
      function deployNoticeEl() {
        let el = document.querySelector("#deployNotice");
        if (!el) {
          el = document.createElement("div");
          el.id = "deployNotice";
          el.className = "deployNotice";
          el.hidden = true;
          document.body.appendChild(el);
        }
        return el;
      }
      function startDeployWatch() {
        const check = async () => {
          let info = null;
          try {
            const r = await fetch("/deploy.json", { cache: "no-store" });
            if (r.ok) info = await r.json();
          } catch {}
          const el = deployNoticeEl();
          if (info?.status === "deploying") {
            const started = Date.parse(info.startedAt || "") || Date.now();
            if (Date.now() - started < 30 * 60 * 1000) {
              el.innerHTML = `<span class="deployNoticeDot" aria-hidden="true"></span> Se está publicando una nueva versión — evita guardar cambios en este momento.`;
              el.classList.remove("ready");
              el.hidden = false;
              return;
            }
          }
          if (info?.status === "ok" && info.buildId) {
            if (deployBaselineBuildId === null) {
              deployBaselineBuildId = info.buildId;
            } else if (info.buildId !== deployBaselineBuildId) {
              el.innerHTML = `✓ Hay una versión nueva disponible. <button type="button" class="deployNoticeReload">Recargar</button>`;
              el.classList.add("ready");
              el.hidden = false;
              el.querySelector(".deployNoticeReload")?.addEventListener("click", () => window.location.reload());
              return;
            }
          }
          el.hidden = true;
        };
        check();
        window.setInterval(check, DEPLOY_POLL_MS);
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
            label: "Solicitudes",
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
        playBrandWelcome();
      }

      function setUserMenuOpen(open) {
        elements.userMenuDropdown.hidden = !open;
        elements.userMenuButton.setAttribute("aria-expanded", String(Boolean(open)));
      }

      function logout(sessionExpired) {
        setUserMenuOpen(false);
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
        elements.app.classList.remove("booting");
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
        elements.userMenu.hidden = true;
        setUserMenuOpen(false);
        elements.userLabel.textContent = "Sin sesión";
      }

      function renderApp() {
        state.sessionExpiredHandled = false;
        scheduleSessionWatchdog();
        elements.app.classList.remove("booting");
        elements.app.classList.remove("loginOnly");
        elements.loginLanding.hidden = true;
        elements.loginButton.hidden = true;
        elements.userMenu.hidden = false;
        // Nombre visible como línea principal; el correo (si es distinto) va en su
        // propia línea con elipsis — evita el corte feo del email en dos líneas.
        const uName = state.profile.user.name || state.profile.user.email;
        elements.userLabel.textContent = uName;
        elements.userLabel.title = state.profile.user.email;
        const showEmail = uName !== state.profile.user.email;
        elements.userEmailLabel.hidden = !showEmail;
        elements.userEmailLabel.textContent = showEmail ? state.profile.user.email : "";
        elements.userEmailLabel.title = state.profile.user.email;
        elements.environmentLabel.textContent = state.profile.environment;
        renderNav();
        renderModule(state.activeModule);
      }

      // Entrada suave de una vista (cambio de módulo o de pestaña): Web Animations
      // API sobre el contenedor — no usa clases (los renders resetean className) y
      // NO se re-dispara en los repintados de sondeos (solo se llama en navegación
      // explícita). Respeta prefers-reduced-motion (accesibilidad).
      // Gesto de bienvenida al entrar (boot con sesión o login): el logo (mano con
      // engrane) entra inclinado desde la "muñeca" y se endereza presentando el
      // engrane; ese movimiento desliza el texto de la marca a su posición final.
      // Los nodos de .brand son estáticos (no se re-renderizan), así que la
      // animación corre una vez por entrada; se re-arma quitando y re-poniendo la
      // clase (con reflow) por si hay logout→login sin recargar.
      function playBrandWelcome() {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        // Espera DOS frames: el primero deja que el navegador pinte el layout ya
        // logueado (renderApp acaba de revelar el sidebar y renderizar el módulo,
        // trabajo síncrono pesado que si no se espera "se come" los primeros
        // frames del gesto — por eso en el login se veía la mano ya colocada y
        // solo la cola del texto). Con el sidebar ya pintado, el gesto arranca
        // desde el frame 0 igual que al recargar.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (elements.app.classList.contains("loginOnly") || elements.app.classList.contains("booting")) return;
          elements.app.classList.remove("welcomeAnim");
          void elements.app.offsetWidth;   // reinicia la animación (logout→login sin recargar)
          elements.app.classList.add("welcomeAnim");
        }));
      }

      function animateViewEnter() {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        try {
          elements.contentPanel.animate(
            [{ opacity: 0.3, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
            { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        } catch {}
      }

      function renderNav() {
        elements.moduleNav.innerHTML = "";
        const visibleModules = getVisibleModules(state.profile.modules);
        state.activeModule = normalizeModuleKey(state.activeModule);
        // "staff" (Personal) no es entrada del menú lateral: vive en el menú del
        // usuario. Es una vista válida aunque no esté en visibleModules.
        if (state.activeModule !== "staff" && !visibleModules.some((module) => module.key === state.activeModule)) {
          state.activeModule = getDefaultModule(visibleModules);
        }

        for (const module of visibleModules) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = module.label;
          button.className = module.key === state.activeModule ? "navItem active" : "navItem";
          button.addEventListener("click", () => {
            const changed = state.activeModule !== module.key;
            state.activeModule = module.key;
            window.sessionStorage.setItem("gestionProyectosModule", module.key);
            renderApp();
            if (changed) animateViewEnter();
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
        state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes, catalogSyncedLabel, mdLite,
        animateViewEnter,
      });
      const adminModule = createAdminModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton,
      });
      const workspaceModule = createWorkspaceModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, renderDeleteIconButton, priorityLabel, mdLite,
      });
      const catalogModule = createCatalogModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, formatBytes, catalogSyncedLabel, catalogDateLabel,
      });
      const chatModule = createChatModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, mdLite,
      });
      const drawModule = createDrawModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, renderDeleteIconButton,
      });
      const staffModule = createStaffModule({
        state, elements, apiRequest, escapeHtml, escapeAttribute, renderEditIconButton, renderDeleteIconButton,
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
        if (moduleKey === "chat") {
          chatModule.render();
          return;
        }
        if (moduleKey === "draw") {
          drawModule.render();
          return;
        }
        if (moduleKey === "staff") {
          staffModule.render();
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

        // Clave desconocida (p. ej. una pestaña retirada que quedó en datos viejos).
        // El backend ya la excluye del menú y renderNav resetea el módulo activo, así
        // que esto casi nunca ocurre; como red de seguridad se muestra el Panel en
        // vez de renderizar andamiaje inexistente.
        homeModule.render();
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
        // Etiqueta desde el catálogo del payload (fuente única en el backend:
        // TASK_PRIORITIES_CATALOG); el mapa local es solo fallback pre-carga.
        const fromCatalog = state.workspace?.taskPriorities?.find((p) => p.key === priority)?.label;
        if (fromCatalog) return fromCatalog;
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

      // Papelera para borrar (convención de la app: editar → lápiz, borrar →
      // papelera+confirm, ambos con tooltip). Ver estándar #5 en docs/06.
      function renderDeleteIconButton(label, attributes) {
        return `
          <button class="iconTinyButton iconTinyButton--danger" type="button" ${attributes} aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M4 7h16"></path>
              <path d="M9 7V4.5h6V7"></path>
              <path d="M6.5 7l1 12.5h9l1-12.5"></path>
              <path d="M10 10.5v6M14 10.5v6"></path>
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

      // Formateador de markdown ligero para respuestas del LLM (negritas, cursivas,
      // código en línea, bloques ```lang```, listas, párrafos) — sin librería
      // externa, solo lo que el modelo realmente usa. Todo el texto se escapa antes
      // de insertar las etiquetas, sigue siendo seguro contra HTML/inyección.
      // Compartido entre módulos (Athena → sugerencia de query, chat de apoyo técnico).
      function mdInline(s) {
        return escapeHtml(s)
          .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
          .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>")
          .replace(/`([^`]+)`/g, "<code>$1</code>");
      }
      // Tabla markdown (| col | col |). Si la 2a línea es el separador |---|---|,
      // la 1a fila es encabezado. Celdas con mdInline (negritas, código).
      function mdTable(lines) {
        const rows = lines.map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
        let header = null, bodyRows = rows;
        if (rows.length >= 2 && rows[1].length && rows[1].every((c) => /^:?-{2,}:?$/.test(c))) {
          header = rows[0];
          bodyRows = rows.slice(2);
        }
        const th = header ? `<thead><tr>${header.map((c) => `<th>${mdInline(c)}</th>`).join("")}</tr></thead>` : "";
        const tb = `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
        return `<div class="mdTableWrap"><table class="mdTable">${th}${tb}</table></div>`;
      }
      function mdBlock(text) {
        const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
        return paragraphs.map((p) => {
          const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
          if (lines.length >= 2 && lines.every((l) => l.startsWith("|"))) return mdTable(lines);
          if (lines.length && lines.every((l) => /^\d+[.)]\s/.test(l))) {
            return `<ol>${lines.map((l) => `<li>${mdInline(l.replace(/^\d+[.)]\s/, ""))}</li>`).join("")}</ol>`;
          }
          if (lines.length && lines.every((l) => /^[-*]\s/.test(l))) {
            return `<ul>${lines.map((l) => `<li>${mdInline(l.replace(/^[-*]\s/, ""))}</li>`).join("")}</ul>`;
          }
          // Mixto: encabezados (#..####), separadores (---) y texto en el mismo bloque.
          let out = "", buf = [];
          const flush = () => { if (buf.length) { out += `<p>${buf.map(mdInline).join("<br>")}</p>`; buf = []; } };
          for (const l of lines) {
            const h = l.match(/^(#{1,4})\s+(.*)$/);
            if (h) { flush(); const lvl = Math.min(h[1].length + 2, 6); out += `<h${lvl} class="mdH">${mdInline(h[2])}</h${lvl}>`; }
            else if (/^(-{3,}|\*{3,}|_{3,})$/.test(l)) { flush(); out += `<hr class="mdHr">`; }
            else buf.push(l);
          }
          flush();
          return out;
        }).join("");
      }
      function mdLite(text) {
        if (!text) return "";
        const parts = String(text).split(/```(\w*)\n?([\s\S]*?)```/g);
        let out = "";
        for (let i = 0; i < parts.length; i++) {
          const mod = i % 3;
          if (mod === 0 && parts[i]) out += mdBlock(parts[i]);
          else if (mod === 2) out += `<pre class="llmCode">${escapeHtml(parts[i].trimEnd())}</pre>`;
        }
        return out;
      }

      function renderStatus(title, message) {
        elements.app.classList.remove("booting");
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
        elements.app.classList.remove("booting");
        elements.app.classList.add("loginOnly");
        elements.loginLanding.hidden = false;
        elements.statusPanel.hidden = true;
        elements.contentPanel.hidden = true;
        elements.loginButton.hidden = true;
        elements.userMenu.hidden = true;
        setUserMenuOpen(false);
        elements.userLabel.textContent = "Sin sesión";
        elements.landingLoginButton.disabled = true;
        elements.loginLandingMessage.textContent = message;
      }
