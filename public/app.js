/* ============================================
   aiMessage — Frontend Application (xterm.js)
   ============================================ */

// --- State ---
const state = {
  sessions: [],
  activeView: 'home',       // 'home' | 'conversation'
  activeSessionId: null,
  activeGroup: null,
  multiMode: false,
  panels: [],                // array of session IDs in multi mode
  searchQuery: '',
};

// Per-panel terminal state: sessionId -> { terminal, ws, fitAddon, resizeObserver, reconnectTimer, reconnectDelay }
const panelState = new Map();

// Polling interval for session list refresh
let pollInterval = null;
const POLL_INTERVAL_MS = 5000;

// --- DOM References ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  app: $('#app'),
  homeView: $('#home-view'),
  splitView: $('#split-view'),
  sessionList: $('#session-list'),
  sidebarList: $('#sidebar-list'),
  panelsContainer: $('#panels-container'),
  backBtn: $('#back-btn'),
  homeSearch: $('#home-search'),
  sidebarSearch: $('#sidebar-search'),
  modal: $('#new-session-modal'),
  modalCloseBtn: $('#modal-close-btn'),
  newSessionBtn: $('#new-session-btn'),
  newSessionForm: $('#new-session-form'),
  panelTemplate: $('#panel-template'),
};

// --- API ---
async function apiGetSessions() {
  const res = await fetch('/sessions');
  if (!res.ok) throw new Error(`GET /sessions failed: ${res.status}`);
  return res.json();
}

async function apiCreateSession(name, group, workingDir) {
  const res = await fetch('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, group: group || undefined, workingDir: workingDir || undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `POST /sessions failed: ${res.status}`);
  }
  return res.json();
}

async function apiDeleteSession(sessionId) {
  const res = await fetch(`/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE /sessions/${sessionId} failed: ${res.status}`);
  return res.json();
}

// --- Utility ---
function timeAgo(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Rendering: Session Rows ---
function renderSessionRow(session, context = 'home') {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.dataset.sessionId = session.id;

  if (state.activeSessionId === session.id) {
    row.classList.add('selected');
  }

  const unreadClass = session.unread ? '' : 'hidden-dot';
  const groupHtml = session.group ? `<span class="session-row-group">${escapeHtml(session.group)}</span>` : '';
  const time = session.lastActivity ? timeAgo(new Date(session.lastActivity)) : '';

  row.innerHTML = `
    <div class="session-row-left">
      <span class="session-row-unread ${unreadClass}"></span>
      <span class="status-dot ${session.status}"></span>
    </div>
    <div class="session-row-body">
      <div class="session-row-top">
        <span class="session-row-name">${escapeHtml(session.name)}${groupHtml}</span>
        <span class="session-row-time">${time}</span>
      </div>
      <div class="session-row-preview">${escapeHtml(session.preview || '')}</div>
    </div>
    <button class="session-row-add" title="Open in panel">+</button>
  `;

  // Click row -> open conversation
  row.addEventListener('click', (e) => {
    if (e.target.closest('.session-row-add')) return;
    openConversation(session.id);
  });

  // Click + -> add to multi panel
  const addBtn = row.querySelector('.session-row-add');
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addPanel(session.id);
  });

  return row;
}

// --- Rendering: Home View ---
function renderHome() {
  dom.sessionList.innerHTML = '';

  const filtered = filterSessions(state.sessions, state.searchQuery);

  // Sort by last activity (most recent first)
  const sorted = [...filtered].sort((a, b) => {
    const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bTime - aTime;
  });

  sorted.forEach(session => {
    dom.sessionList.appendChild(renderSessionRow(session, 'home'));
  });
}

// --- Rendering: Sidebar ---
function renderSidebar() {
  dom.sidebarList.innerHTML = '';

  let sessions = state.sessions;
  if (state.activeGroup) {
    sessions = sessions.filter(s => s.group === state.activeGroup);
  }

  const filtered = filterSessions(sessions, state.searchQuery);

  const sorted = [...filtered].sort((a, b) => {
    const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bTime - aTime;
  });

  sorted.forEach(session => {
    dom.sidebarList.appendChild(renderSessionRow(session, 'sidebar'));
  });
}

function filterSessions(sessions, query) {
  if (!query) return sessions;
  const q = query.toLowerCase();
  return sessions.filter(s =>
    s.name.toLowerCase().includes(q) ||
    (s.group && s.group.toLowerCase().includes(q)) ||
    (s.preview && s.preview.toLowerCase().includes(q))
  );
}

// ============================================
// TERMINAL MANAGEMENT
// ============================================

function createTerminal(sessionId, containerEl) {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    theme: {
      background: '#1E1E1E',
      foreground: '#D4D4D4',
      cursor: '#D4D4D4',
      selectionBackground: 'rgba(255, 255, 255, 0.3)',
      black: '#1E1E1E',
      red: '#F44747',
      green: '#6A9955',
      yellow: '#DCDCAA',
      blue: '#569CD6',
      magenta: '#C586C0',
      cyan: '#4EC9B0',
      white: '#D4D4D4',
      brightBlack: '#808080',
      brightRed: '#F44747',
      brightGreen: '#6A9955',
      brightYellow: '#DCDCAA',
      brightBlue: '#569CD6',
      brightMagenta: '#C586C0',
      brightCyan: '#4EC9B0',
      brightWhite: '#FFFFFF',
    },
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon());

  // Mount terminal to DOM first
  terminal.open(containerEl);

  // Try WebGL renderer for performance AFTER open(), fall back gracefully
  try {
    terminal.loadAddon(new WebglAddon.WebglAddon());
  } catch (e) {
    console.warn('WebGL addon failed to load, using canvas renderer:', e);
  }

  fitAddon.fit();

  // Connect WebSocket
  const ws = connectWebSocket(sessionId, terminal);

  // ResizeObserver for auto-fitting
  const resizeObserver = new ResizeObserver(() => {
    try {
      fitAddon.fit();
    } catch (e) {
      // fitAddon can throw if terminal is disposed
      return;
    }
    const ps = panelState.get(sessionId);
    if (ps && ps.ws && ps.ws.readyState === WebSocket.OPEN) {
      ps.ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }
  });
  resizeObserver.observe(containerEl);

  // Store state
  panelState.set(sessionId, {
    terminal,
    ws,
    fitAddon,
    resizeObserver,
    reconnectTimer: null,
    reconnectDelay: 2000,
  });

  return terminal;
}

function connectWebSocket(sessionId, terminal) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/sessions/${sessionId}/stream`);

  // Receive binary data as ArrayBuffer so xterm.js can handle it properly
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // Remove disconnected overlay if present
    const panel = document.querySelector(`.panel[data-session-id="${sessionId}"]`);
    if (panel) {
      const overlay = panel.querySelector('.terminal-disconnected');
      if (overlay) overlay.remove();
    }

    const ps = panelState.get(sessionId);
    if (ps) {
      ps.reconnectDelay = 2000; // Reset backoff on successful connect
      // Send initial resize
      ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    }
  };

  // Server sends raw terminal data as binary
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      terminal.write(new Uint8Array(event.data));
    } else {
      terminal.write(event.data);
    }

    // Update session's last activity for sidebar sorting
    const session = state.sessions.find(s => s.id === sessionId);
    if (session) {
      session.lastActivity = new Date().toISOString();

      // Mark as unread if not the active panel
      if (state.activeSessionId !== sessionId) {
        session.unread = true;
      }
    }
  };

  // Terminal input goes to server
  terminal.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  ws.onclose = () => {
    handleDisconnect(sessionId);
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };

  return ws;
}

function handleDisconnect(sessionId) {
  const ps = panelState.get(sessionId);
  if (!ps) return;

  // Show disconnected overlay
  const panel = document.querySelector(`.panel[data-session-id="${sessionId}"]`);
  if (panel) {
    const container = panel.querySelector('.terminal-container');
    if (container && !container.querySelector('.terminal-disconnected')) {
      const overlay = document.createElement('div');
      overlay.className = 'terminal-disconnected';
      overlay.textContent = 'Disconnected — reconnecting...';
      container.appendChild(overlay);
    }
  }

  // Reconnect with exponential backoff
  const delay = ps.reconnectDelay;
  ps.reconnectDelay = Math.min(ps.reconnectDelay * 1.5, 30000);

  ps.reconnectTimer = setTimeout(() => {
    // Only reconnect if panel still exists
    if (!panelState.has(sessionId)) return;
    const newWs = connectWebSocket(sessionId, ps.terminal);
    ps.ws = newWs;
  }, delay);
}

function destroyPanel(sessionId) {
  const ps = panelState.get(sessionId);
  if (!ps) return;

  // Clear reconnect timer
  if (ps.reconnectTimer) {
    clearTimeout(ps.reconnectTimer);
  }

  // Close WebSocket
  if (ps.ws) {
    ps.ws.onclose = null; // Prevent reconnect logic
    ps.ws.close();
  }

  // Disconnect resize observer
  if (ps.resizeObserver) {
    ps.resizeObserver.disconnect();
  }

  // Dispose terminal
  if (ps.terminal) {
    ps.terminal.dispose();
  }

  panelState.delete(sessionId);
}

// ============================================
// PANEL RENDERING
// ============================================

function renderPanel(sessionId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return null;

  const template = dom.panelTemplate.content.cloneNode(true);
  const panel = template.querySelector('.panel');
  panel.dataset.sessionId = sessionId;

  // Header
  panel.querySelector('.status-dot').className = `status-dot ${session.status}`;
  panel.querySelector('.panel-name').textContent = session.name;
  panel.querySelector('.panel-group-label').textContent = session.group || '';
  if (!session.group) {
    panel.querySelector('.panel-group-label').style.display = 'none';
  }
  panel.querySelector('.panel-dir').textContent = session.workingDir || '';

  // Close panel
  panel.querySelector('.panel-close-btn').addEventListener('click', () => {
    removePanel(sessionId);
  });

  // Mark as active
  if (state.activeSessionId === sessionId || state.panels.length === 0) {
    panel.classList.add('active');
  }

  // Click to make active and focus terminal
  panel.addEventListener('click', () => {
    setActivePanel(sessionId);
  });

  return panel;
}

// --- View Management ---
function showHome() {
  // Destroy all terminal panels
  for (const sessionId of [...panelState.keys()]) {
    destroyPanel(sessionId);
  }

  state.activeView = 'home';
  state.activeSessionId = null;
  state.activeGroup = null;
  state.multiMode = false;
  state.panels = [];
  dom.homeView.classList.remove('hidden');
  dom.splitView.classList.add('hidden');
  renderHome();
}

function openConversation(sessionId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return;

  // Destroy existing panels
  for (const sid of [...panelState.keys()]) {
    destroyPanel(sid);
  }

  state.activeView = 'conversation';
  state.activeSessionId = sessionId;

  // Clear unread
  session.unread = false;

  // If session has a group, filter sidebar to that group
  if (session.group) {
    state.activeGroup = session.group;
  } else {
    state.activeGroup = null;
  }

  // Set single panel mode
  state.multiMode = false;
  state.panels = [sessionId];

  dom.homeView.classList.add('hidden');
  dom.splitView.classList.remove('hidden');

  renderSidebar();
  renderPanels();
}

function addPanel(sessionId) {
  if (state.panels.includes(sessionId)) return;
  if (state.panels.length >= 4) return;

  if (state.activeView === 'home') {
    openConversation(sessionId);
    return;
  }

  state.multiMode = true;
  state.panels.push(sessionId);
  state.activeSessionId = sessionId;

  // Clear unread
  const session = state.sessions.find(s => s.id === sessionId);
  if (session) session.unread = false;

  renderSidebar();
  renderPanels();
}

function removePanel(sessionId) {
  // Destroy terminal for this panel
  destroyPanel(sessionId);

  state.panels = state.panels.filter(id => id !== sessionId);

  if (state.panels.length === 0) {
    showHome();
    return;
  }

  if (state.activeSessionId === sessionId) {
    state.activeSessionId = state.panels[0];
  }

  state.multiMode = state.panels.length > 1;

  renderSidebar();
  renderPanels();
}

function setActivePanel(sessionId) {
  if (state.activeSessionId === sessionId) {
    // Still focus the terminal
    const ps = panelState.get(sessionId);
    if (ps && ps.terminal) ps.terminal.focus();
    return;
  }

  state.activeSessionId = sessionId;

  // Clear unread
  const session = state.sessions.find(s => s.id === sessionId);
  if (session) session.unread = false;

  // Update active class on panels
  $$('.panel').forEach(p => {
    p.classList.toggle('active', p.dataset.sessionId === sessionId);
  });

  // Update sidebar selection
  $$('.session-row').forEach(r => {
    r.classList.toggle('selected', r.dataset.sessionId === sessionId);
  });

  // Focus the terminal
  const ps = panelState.get(sessionId);
  if (ps && ps.terminal) ps.terminal.focus();
}

function renderPanels() {
  // Destroy any terminals for panels no longer in the list
  for (const [sid] of panelState) {
    if (!state.panels.includes(sid)) {
      destroyPanel(sid);
    }
  }

  dom.panelsContainer.innerHTML = '';
  dom.panelsContainer.className = `panels-${state.panels.length}`;

  state.panels.forEach(sessionId => {
    const panel = renderPanel(sessionId);
    if (panel) {
      dom.panelsContainer.appendChild(panel);

      // Create terminal in the container after it's in the DOM
      const containerEl = dom.panelsContainer.querySelector(
        `.panel[data-session-id="${sessionId}"] .terminal-container`
      );
      if (containerEl && !panelState.has(sessionId)) {
        const terminal = createTerminal(sessionId, containerEl);
        // Focus the active terminal
        if (state.activeSessionId === sessionId) {
          setTimeout(() => terminal.focus(), 50);
        }
      } else if (panelState.has(sessionId)) {
        // Terminal already exists — re-mount it
        destroyPanel(sessionId);
        const terminal = createTerminal(sessionId, containerEl);
        if (state.activeSessionId === sessionId) {
          setTimeout(() => terminal.focus(), 50);
        }
      }
    }
  });
}

function refreshActiveView() {
  if (state.activeView === 'home') {
    renderHome();
  } else {
    renderSidebar();
    // Don't re-render panels (would destroy terminals)
    // Just update sidebar and panel headers
    updatePanelHeaders();
  }
}

function updatePanelHeaders() {
  for (const sessionId of state.panels) {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) continue;
    const panel = document.querySelector(`.panel[data-session-id="${sessionId}"]`);
    if (!panel) continue;
    const dot = panel.querySelector('.status-dot');
    if (dot) dot.className = `status-dot ${session.status}`;
    const preview = panel.querySelector('.panel-name');
    if (preview) preview.textContent = session.name;
  }
}

// --- Modal ---
function openModal() {
  dom.modal.classList.remove('hidden');
  // Populate group dropdown
  const select = $('#session-group');
  const groups = [...new Set(state.sessions.map(s => s.group).filter(Boolean))];
  select.innerHTML = '<option value="">None</option>';
  groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    select.appendChild(opt);
  });
  setTimeout(() => $('#session-name').focus(), 50);
}

function closeModal() {
  dom.modal.classList.add('hidden');
  dom.newSessionForm.reset();
}

// --- Search ---
function handleSearch(query) {
  state.searchQuery = query;
  if (state.activeView === 'home') {
    renderHome();
  } else {
    renderSidebar();
  }
}

// --- Polling: Fetch sessions from server periodically ---
async function fetchAndUpdateSessions() {
  try {
    const serverSessions = await apiGetSessions();
    // Merge server data with local unread state
    const unreadMap = new Map();
    for (const s of state.sessions) {
      unreadMap.set(s.id, s.unread || false);
    }
    state.sessions = serverSessions.map(s => ({
      ...s,
      unread: unreadMap.has(s.id) ? unreadMap.get(s.id) : false,
    }));
    refreshActiveView();
  } catch (err) {
    console.error('Failed to fetch sessions:', err);
  }
}

function startPolling() {
  fetchAndUpdateSessions(); // Initial fetch
  pollInterval = setInterval(fetchAndUpdateSessions, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// --- Event Listeners ---
function initEventListeners() {
  // Back button
  dom.backBtn.addEventListener('click', showHome);

  // New session
  dom.newSessionBtn.addEventListener('click', openModal);
  dom.modalCloseBtn.addEventListener('click', closeModal);

  // Modal overlay click to close
  dom.modal.addEventListener('click', (e) => {
    if (e.target === dom.modal) closeModal();
  });

  // New session form submit — calls the server API
  dom.newSessionForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#session-name').value.trim() || 'Untitled';
    const group = $('#session-group').value || null;
    const dir = $('#session-dir').value.trim() || undefined;
    const message = $('#session-message').value.trim();

    const submitBtn = dom.newSessionForm.querySelector('.submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting...';

    try {
      const session = await apiCreateSession(name, group, dir);
      // Add to local state
      session.unread = false;
      state.sessions.unshift(session);

      closeModal();
      openConversation(session.id);

      // If there's an initial message, send it to the terminal after a brief delay
      // to allow the pty/tmux to initialize
      if (message) {
        setTimeout(() => {
          const ps = panelState.get(session.id);
          if (ps && ps.ws && ps.ws.readyState === WebSocket.OPEN) {
            ps.ws.send(message + '\n');
          }
        }, 1500);
      }
    } catch (err) {
      console.error('Failed to create session:', err);
      alert('Failed to create session: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start Session';
    }
  });

  // Search inputs
  dom.homeSearch.addEventListener('input', (e) => handleSearch(e.target.value));
  dom.sidebarSearch.addEventListener('input', (e) => handleSearch(e.target.value));

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;

    // Don't capture shortcuts when typing in modal inputs
    if (e.target.closest('.modal-content') && !meta) return;

    // Cmd+N -> new session
    if (meta && e.key === 'n') {
      e.preventDefault();
      openModal();
      return;
    }

    // Cmd+K -> focus search
    if (meta && e.key === 'k') {
      e.preventDefault();
      if (state.activeView === 'home') {
        dom.homeSearch.focus();
      } else {
        dom.sidebarSearch.focus();
      }
      return;
    }

    // Cmd+1-9 -> jump to session
    if (meta && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const idx = parseInt(e.key) - 1;
      const sorted = getSortedSessions();
      if (sorted[idx]) {
        openConversation(sorted[idx].id);
      }
      return;
    }

    // Cmd+\ -> toggle split
    if (meta && e.key === '\\') {
      e.preventDefault();
      if (e.shiftKey) {
        // Cmd+Shift+\ -> add panel (pick next session)
        const available = state.sessions.filter(s => !state.panels.includes(s.id));
        if (available.length > 0 && state.activeView === 'conversation') {
          addPanel(available[0].id);
        }
      } else {
        // Toggle between single and multi panel
        if (state.panels.length > 1) {
          // Keep only active panel, destroy others
          const keepId = state.activeSessionId;
          state.panels.filter(id => id !== keepId).forEach(id => destroyPanel(id));
          state.panels = [keepId];
          state.multiMode = false;
          renderPanels();
        }
      }
      return;
    }

    // Cmd+W -> close panel
    if (meta && e.key === 'w') {
      e.preventDefault();
      if (state.activeView === 'conversation' && state.activeSessionId) {
        removePanel(state.activeSessionId);
      }
      return;
    }

    // Cmd+. -> send Ctrl+C to active terminal via WebSocket
    if (meta && e.key === '.') {
      e.preventDefault();
      if (state.activeSessionId) {
        const ps = panelState.get(state.activeSessionId);
        if (ps && ps.ws && ps.ws.readyState === WebSocket.OPEN) {
          ps.ws.send('\x03');
        }
      }
      return;
    }

    // Escape -> back/close
    if (e.key === 'Escape') {
      if (!dom.modal.classList.contains('hidden')) {
        closeModal();
      } else if (state.activeView === 'conversation') {
        showHome();
      }
      return;
    }
  });
}

function getSortedSessions() {
  return [...state.sessions].sort((a, b) => {
    const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bTime - aTime;
  });
}

// --- Init ---
function init() {
  initEventListeners();
  startPolling();
}

document.addEventListener('DOMContentLoaded', init);
