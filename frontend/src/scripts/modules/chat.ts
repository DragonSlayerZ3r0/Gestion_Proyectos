// @ts-nocheck
// Módulo "Apoyo técnico": chat con LLM (mismo modelo y backend que la sugerencia
// de Athena — GLM 5 vía Bedrock, llamada directa sin Agent). Interfaz de dos
// paneles al estilo ChatGPT: sidebar con las conversaciones guardadas en DynamoDB
// (a la izquierda) + panel de mensajes con input abajo (a la derecha).
export function createChatModule(ctx) {
  const { state, elements, apiRequest, escapeHtml, escapeAttribute, mdLite } = ctx;

  function relTime(iso) {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.round(ms / 60000);
    if (min < 1) return "ahora";
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} d`;
  }

  async function ensureSessions() {
    if (state.chatSessions !== null || state.chatSessionsLoading) return;
    state.chatSessionsLoading = true;
    paintChat();
    try {
      const p = await apiRequest("api/chat/sessions");
      state.chatSessions = p.data.sessions || [];
    } catch {
      state.chatSessions = [];
    }
    state.chatSessionsLoading = false;
    paintChat();
  }

  async function loadMessages(sessionId) {
    if (!sessionId || state.chatMessages[sessionId]) return;
    state.chatMessagesLoading[sessionId] = true;
    paintChat();
    try {
      const p = await apiRequest(`api/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
      state.chatMessages[sessionId] = p.data.messages || [];
      // Si se reabre una conversación con una respuesta aún en camino (p. ej.
      // tras recargar la página a mitad de la generación), retoma el polling.
      if (p.data.status === "generating" && !state.chatGenerating[sessionId]) {
        state.chatGenerating[sessionId] = true;
        pollReply(sessionId);
      }
    } catch {
      state.chatMessages[sessionId] = [];
    }
    state.chatMessagesLoading[sessionId] = false;
    if (state.chatActiveSessionId === sessionId) paintChat();
  }

  // Sondea hasta que el worker asíncrono guarde la respuesta (status deja de ser
  // "generating"). El backend genera en segundo plano porque el razonador puede
  // tardar más que los 30 s duros de API Gateway; aquí solo esperamos y refrescamos.
  async function pollReply(sessionId) {
    for (let i = 0; i < 150; i++) {                    // tope ~5 min (igual que la Lambda)
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const p = await apiRequest(`api/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
        state.chatMessages[sessionId] = p.data.messages || [];
        if (p.data.status !== "generating") break;
        if (state.chatActiveSessionId === sessionId) paintChat();
      } catch {}                                        // red intermitente: seguir intentando
    }
    delete state.chatGenerating[sessionId];
    if (state.chatActiveSessionId === sessionId) paintChat();
  }

  function selectSession(sessionId) {
    if (state.chatActiveSessionId === sessionId) return;
    state.chatActiveSessionId = sessionId;
    state.chatError = "";
    paintChat();
    loadMessages(sessionId);
  }

  function newChat() {
    if (state.chatActiveSessionId === null) return;
    state.chatActiveSessionId = null;
    state.chatError = "";
    paintChat();
  }

  async function removeSession(sessionId) {
    if (!window.confirm("¿Eliminar esta conversación? No se puede deshacer.")) return;
    try {
      await apiRequest(`api/chat/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    } catch {}
    state.chatSessions = (state.chatSessions || []).filter((s) => s.sessionId !== sessionId);
    delete state.chatMessages[sessionId];
    if (state.chatActiveSessionId === sessionId) state.chatActiveSessionId = null;
    paintChat();
  }

  async function sendMessage() {
    const input = elements.contentPanel.querySelector("#chatInput");
    const text = (input?.value || "").trim();
    const sessionId = state.chatActiveSessionId;
    if (!text || state.chatSending || (sessionId && state.chatGenerating[sessionId])) return;
    input.value = "";

    const now = new Date().toISOString();
    if (sessionId) {
      state.chatMessages[sessionId] = [...(state.chatMessages[sessionId] || []), { role: "user", text, createdAt: now }];
    }
    state.chatSending = true;
    state.chatError = "";
    paintChat();

    try {
      // El POST solo ENCOLA (regresa de inmediato con pending); la respuesta la
      // genera un worker asíncrono y se recoge con pollReply — así el razonador
      // puede tardar lo que necesite sin chocar con el timeout de API Gateway.
      const p = await apiRequest("api/chat/messages", {
        method: "POST",
        body: JSON.stringify({ sessionId, text }),
      });
      const newId = p.data.sessionId;
      if (!sessionId) {
        // Era conversación nueva: se acaba de crear en el backend.
        state.chatMessages[newId] = [{ role: "user", text, createdAt: now }];
        state.chatSessions = [
          { sessionId: newId, title: p.data.title, updatedAt: new Date().toISOString(), messageCount: 1 },
          ...(state.chatSessions || []),
        ];
      } else {
        const idx = (state.chatSessions || []).findIndex((s) => s.sessionId === newId);
        if (idx > 0) {
          const list = [...state.chatSessions];
          const [s] = list.splice(idx, 1);
          list.unshift({ ...s, updatedAt: new Date().toISOString() });
          state.chatSessions = list;
        } else if (idx === 0) {
          state.chatSessions[0] = { ...state.chatSessions[0], updatedAt: new Date().toISOString() };
        }
      }
      state.chatActiveSessionId = newId;
      state.chatGenerating[newId] = true;
      state.chatSending = false;
      paintChat();
      await pollReply(newId);
      return;
    } catch (err) {
      state.chatError = err?.message || "No se pudo enviar el mensaje.";
    }
    state.chatSending = false;
    paintChat();
  }

  function scrollToBottom() {
    const box = elements.contentPanel.querySelector("#chatMessages");
    if (box) box.scrollTop = box.scrollHeight;
  }

  function bindEvents() {
    const newBtn = elements.contentPanel.querySelector("#chatNewBtn");
    if (newBtn) newBtn.addEventListener("click", newChat);
    for (const el of elements.contentPanel.querySelectorAll("[data-chat-session]")) {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-chat-delete]")) return;
        selectSession(el.dataset.chatSession);
      });
    }
    for (const el of elements.contentPanel.querySelectorAll("[data-chat-delete]")) {
      el.addEventListener("click", (e) => { e.stopPropagation(); removeSession(el.dataset.chatDelete); });
    }
    const sendBtn = elements.contentPanel.querySelector("#chatSendBtn");
    if (sendBtn) sendBtn.addEventListener("click", sendMessage);
    const input = elements.contentPanel.querySelector("#chatInput");
    if (input) {
      input.focus();
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
      });
      input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      });
    }
  }

  function paintChat() {
    elements.statusPanel.hidden = true;
    elements.contentPanel.hidden = false;
    elements.contentPanel.className = "contentGrid";
    elements.viewTitle.textContent = "Apoyo técnico";

    const sessions = state.chatSessions || [];
    const activeId = state.chatActiveSessionId;
    const messages = activeId ? (state.chatMessages[activeId] || []) : [];
    const loadingMsgs = activeId && state.chatMessagesLoading[activeId];

    const sessionsHtml = state.chatSessionsLoading
      ? `<p class="chatSidebarEmpty">Cargando…</p>`
      : sessions.length
      ? sessions.map((s) => `
        <div class="chatSessionItem${s.sessionId === activeId ? " active" : ""}" data-chat-session="${escapeAttribute(s.sessionId)}">
          <div class="chatSessionInfo">
            <span class="chatSessionTitle">${escapeHtml(s.title || "Nueva conversación")}</span>
            <span class="chatSessionMeta">${relTime(s.updatedAt)}</span>
          </div>
          <button type="button" class="chatSessionDelete" data-chat-delete="${escapeAttribute(s.sessionId)}" aria-label="Eliminar conversación" title="Eliminar">×</button>
        </div>`).join("")
      : `<p class="chatSidebarEmpty">Sin conversaciones aún</p>`;

    const messagesHtml = loadingMsgs
      ? `<div class="chatEmpty">Cargando conversación…</div>`
      : messages.length
      ? messages.map((m) => `
        <div class="chatMsg chatMsg-${m.role === "assistant" ? "assistant" : "user"}">
          <div class="chatBubble">${m.role === "assistant" ? mdLite(m.text) : `<p>${escapeHtml(m.text)}</p>`}</div>
        </div>`).join("")
      : `<div class="chatEmpty">Pregunta lo que necesites: dudas de SQL, AWS, cómo mejorar un query, o cualquier tema técnico de la plataforma.</div>`;

    const busy = state.chatSending || (activeId && state.chatGenerating[activeId]);
    const typingHtml = busy
      ? `<div class="chatMsg chatMsg-assistant"><div class="chatBubble chatTyping">Escribiendo…</div></div>`
      : "";
    const errorHtml = state.chatError
      ? `<div class="chatErrorBanner">${escapeHtml(state.chatError)}</div>`
      : "";

    elements.contentPanel.innerHTML = `
      <article class="panel chatPanel">
        <div class="chatLayout">
          <aside class="chatSidebar">
            <button type="button" class="chatNewBtn" id="chatNewBtn">+ Nueva conversación</button>
            <div class="chatSessionList">${sessionsHtml}</div>
          </aside>
          <div class="chatMain">
            <div class="chatMessages" id="chatMessages">${messagesHtml}${typingHtml}</div>
            ${errorHtml}
            <div class="chatInputRow">
              <textarea id="chatInput" class="chatInput" placeholder="Escribe tu pregunta… (Enter para enviar, Shift+Enter para salto de línea)" rows="1" ${busy ? "disabled" : ""}></textarea>
              <button type="button" id="chatSendBtn" class="chatSendBtn" ${busy ? "disabled" : ""}>Enviar</button>
            </div>
          </div>
        </div>
      </article>`;

    bindEvents();
    scrollToBottom();
  }

  function render() {
    paintChat();
    ensureSessions();
  }

  return { render };
}
