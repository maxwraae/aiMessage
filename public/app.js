/* ============================================
   aiMessage — Frontend Application (xterm.js)
   ============================================ */

// --- State ---
const state = {
  sessions: [],
  projects: {},              // project name -> project metadata
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

// Context menu state
let contextMenuTarget = null; // session ID for context menu

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
  newSessionBtn: $('#new-session-btn'),
  panelTemplate: $('#panel-template'),
  dashboardProjects: $('#dashboard-projects'),
  dashboardRecent: $('#dashboard-recent'),
  sidebarHeaderTitle: $('#sidebar-header-title'),
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

async function apiUpdateSessionMeta(sessionId, updates) {
  const res = await fetch(`/sessions/${sessionId}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`PATCH /sessions/${sessionId}/meta failed: ${res.status}`);
  return res.json();
}

async function apiGetProjects() {
  const res = await fetch('/projects');
  if (!res.ok) throw new Error(`GET /projects failed: ${res.status}`);
  return res.json();
}

async function apiCreateProject(name, color, defaultDir) {
  const res = await fetch('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color, defaultDir }),
  });
  if (!res.ok) throw new Error(`POST /projects failed: ${res.status}`);
  return res.json();
}

async function apiDeleteProject(name) {
  const res = await fetch(`/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE /projects/${name} failed: ${res.status}`);
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

const avatarColors = [
  '#FF6B6B', '#FF9F43', '#FECA57', '#48DBFB', '#0ABDE3',
  '#1DD1A1', '#00D2D3', '#54A0FF', '#5F27CD', '#C44569',
  '#F78FB3', '#3DC1D3', '#E77F67', '#778BEB', '#786FA6'
];

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
}

function getInitial(name) {
  return (name || '?')[0].toUpperCase();
}

// --- Utility: determine if a session is stale (>24h since last activity) ---
function isStale(session) {
  if (!session.lastActivity) return false;
  const diff = Date.now() - new Date(session.lastActivity).getTime();
  return diff > 24 * 60 * 60 * 1000;
}

// --- Rendering: Session Rows ---
function renderSessionRow(session, context = 'home') {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.dataset.sessionId = session.id;

  if (state.activeSessionId === session.id) {
    row.classList.add('selected');
  }

  if (isStale(session)) {
    row.classList.add('stale');
  }

  const unreadClass = session.unread ? '' : 'hidden-dot';
  const groupHtml = session.group ? `<span class="session-row-group">${escapeHtml(session.group)}</span>` : '';
  const time = session.lastActivity ? timeAgo(new Date(session.lastActivity)) : '';

  // Status dot: only show for known statuses; hide for unknown/empty
  const knownStatuses = ['running', 'done', 'idle', 'error'];
  const statusClass = knownStatuses.includes(session.status) ? session.status : '';

  // Project-aware avatar
  const avatarColor = session.projectColor || getAvatarColor(session.name);
  const avatarInitial = session.projectIcon || getInitial(session.name);

  // Pin indicator
  const pinHtml = session.pinned ? '<span class="pin-indicator">pinned</span>' : '';

  row.innerHTML = `
    <div class="session-row-unread ${unreadClass}">
      <span class="session-row-unread-dot"></span>
    </div>
    <div class="session-avatar" style="background: ${avatarColor}">
      <span class="avatar-initial">${avatarInitial}</span>
      <span class="status-dot ${statusClass}"></span>
    </div>
    <div class="session-row-body">
      <div class="session-row-top">
        <span class="session-row-name">${escapeHtml(session.name)}${groupHtml}</span>
        ${pinHtml}
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

  // Right-click -> context menu
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(session.id, e.clientX, e.clientY);
  });

  // Double-click name -> inline rename
  const nameEl = row.querySelector('.session-row-name');
  if (nameEl) {
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(session.id);
    });
  }

  return row;
}

// --- Rendering: Home Dashboard ---
function renderHome() {
  renderProjects();
  renderRecent();
}

// --- Dashboard: group sessions by project ---
function getProjectGroups(sessions) {
  const groups = new Map(); // groupName -> [sessions]

  sessions.forEach(s => {
    const key = s.group || '__ungrouped__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });

  // Sort each group's sessions by lastActivity desc
  for (const [, arr] of groups) {
    arr.sort((a, b) => {
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
  }

  // Sort groups by their most recent session activity desc
  const sorted = [...groups.entries()].sort((a, b) => {
    const aLatest = a[1][0]?.lastActivity ? new Date(a[1][0].lastActivity).getTime() : 0;
    const bLatest = b[1][0]?.lastActivity ? new Date(b[1][0].lastActivity).getTime() : 0;
    return bLatest - aLatest;
  });

  return sorted; // [ [groupName, sessions[]], ... ]
}

// --- Dashboard: render left column (projects) ---
function renderProjects() {
  if (!dom.dashboardProjects) return;

  // Don't blow away the list if user is typing a new project name
  if (dom.dashboardProjects.querySelector('.new-project-input')) return;

  dom.dashboardProjects.innerHTML = '';

  const projectNames = Object.keys(state.projects);

  // Update project count in header
  const countEl = document.getElementById('project-count');
  if (countEl) countEl.textContent = projectNames.length;

  if (projectNames.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'dashboard-empty';
    empty.textContent = 'No projects yet.';
    dom.dashboardProjects.appendChild(empty);
    return;
  }

  projectNames.forEach(name => {
    const project = state.projects[name];
    const sessions = state.sessions.filter(s => s.group === name);
    const running = sessions.filter(s => s.status === 'running').length;
    const total = sessions.length;

    let subtitle = `${total} session${total !== 1 ? 's' : ''}`;
    if (running > 0) subtitle += ` · ${running} running`;

    const MAX_DOTS = 5;
    const dotSessions = sessions.slice(0, MAX_DOTS);
    const overflow = sessions.length - MAX_DOTS;

    const row = document.createElement('div');
    row.className = 'project-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');

    const dotsHtml = dotSessions.map(s => {
      const knownStatuses = ['running', 'done', 'idle', 'error'];
      const cls = knownStatuses.includes(s.status) ? s.status : 'idle';
      return `<span class="status-dot ${cls}"></span>`;
    }).join('');

    const overflowHtml = overflow > 0
      ? `<span class="project-dots-overflow">+${overflow}</span>`
      : '';

    const color = project.color || '#636366';

    row.innerHTML = `
      <div class="project-row-body">
        <div class="project-row-name">
          <span class="project-color-dot" style="background: ${escapeHtml(color)}"></span>
          ${escapeHtml(name)}
        </div>
        <div class="project-row-meta">${escapeHtml(subtitle)}</div>
      </div>
      <div class="project-dots">
        ${dotsHtml}${overflowHtml}
      </div>
    `;

    row.addEventListener('click', () => {
      openProjectView(name, sessions);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openProjectView(name, sessions);
      }
    });

    // Right-click -> project context menu
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showProjectContextMenu(name, e.clientX, e.clientY);
    });

    dom.dashboardProjects.appendChild(row);
  });
}

// --- Dashboard: render right column (recent sessions) ---
function renderRecent() {
  if (!dom.dashboardRecent) return;
  dom.dashboardRecent.innerHTML = '';

  const filtered = filterSessions(state.sessions, state.searchQuery);

  const sorted = [...filtered].sort((a, b) => {
    const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bTime - aTime;
  });

  const recent = sorted.slice(0, 15);

  if (recent.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'dashboard-empty';
    empty.textContent = 'No recent sessions.';
    dom.dashboardRecent.appendChild(empty);
    return;
  }

  recent.forEach(session => {
    const knownStatuses = ['running', 'done', 'idle', 'error'];
    const statusCls = knownStatuses.includes(session.status) ? session.status : 'idle';
    const time = session.lastActivity ? timeAgo(new Date(session.lastActivity)) : '';
    const groupLabel = session.group ? ` · ${escapeHtml(session.group)}` : '';
    const preview = session.preview ? escapeHtml(session.preview) : '';

    const row = document.createElement('div');
    row.className = 'recent-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.sessionId = session.id;

    row.innerHTML = `
      <div class="recent-row-top">
        <span class="status-dot ${statusCls}"></span>
        <span class="recent-row-name">${escapeHtml(session.name)}</span>
        <span class="recent-row-group">${groupLabel}</span>
        <span class="recent-row-time">${time}</span>
      </div>
      ${preview ? `<div class="recent-row-preview">${preview}</div>` : ''}
    `;

    row.addEventListener('click', () => openConversation(session.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openConversation(session.id);
      }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(session.id, e.clientX, e.clientY);
    });

    dom.dashboardRecent.appendChild(row);
  });
}

// --- Open project view: switch to split view filtered to a project group ---
function openProjectView(group, sessions) {
  // Set group filter so sidebar shows only this project
  state.activeGroup = group;

  // Pick the most recent session in this project to open first
  const sorted = [...sessions].sort((a, b) => {
    const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bTime - aTime;
  });

  const firstSession = sorted[0];
  if (!firstSession) {
    // No sessions yet — go to split view in new-session mode for this project
    state.activeView = 'conversation';
    state.activeSessionId = null;
    state.multiMode = false;
    state.panels = [];
    dom.homeView.classList.add('hidden');
    dom.splitView.classList.remove('hidden');
    renderSidebar();
    dom.panelsContainer.innerHTML = '';
    startNewSession();
    return;
  }

  openConversation(firstSession.id);
}

// --- Rendering: Sidebar ---
function renderSidebar() {
  // Update sidebar header title
  if (dom.sidebarHeaderTitle) {
    dom.sidebarHeaderTitle.textContent = state.activeGroup || 'Sessions';
  }

  // Preserve the new session row element before clearing
  const newRow = document.getElementById('new-session-row');
  const newRowVisible = newRow && newRow.style.display !== 'none';

  dom.sidebarList.innerHTML = '';

  // Re-insert new session row at top if it was visible
  if (newRow) {
    dom.sidebarList.appendChild(newRow);
  }

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
      background: '#ffffff',
      foreground: '#1a1a1a',
      cursor: '#007AFF',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(0,122,255,0.2)',
      black: '#1a1a1a',
      red: '#d92020',
      green: '#1a8a1a',
      yellow: '#a06000',
      blue: '#007AFF',
      magenta: '#8b2be2',
      cyan: '#0e7490',
      white: '#f5f5f5',
      brightBlack: '#6b6b6b',
      brightRed: '#e03030',
      brightGreen: '#2db52d',
      brightYellow: '#c07800',
      brightBlue: '#3399ff',
      brightMagenta: '#a855f7',
      brightCyan: '#06b6d4',
      brightWhite: '#ffffff',
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

// --- New Project (inline creation in dashboard) ---
function startNewProject() {
  const container = dom.dashboardProjects;
  if (!container) return;

  // Check if already creating
  if (container.querySelector('.new-project-input')) return;

  const row = document.createElement('div');
  row.className = 'project-row new-project-row';
  row.innerHTML = `
    <div class="project-row-body">
      <input type="text" class="new-project-input" placeholder="Project name..." autofocus>
    </div>
  `;
  container.appendChild(row);

  const input = row.querySelector('.new-project-input');
  input.focus();

  async function commit() {
    const name = input.value.trim();
    if (!name) {
      row.remove();
      return;
    }
    try {
      await apiCreateProject(name);
      row.remove();
      await fetchAndUpdateSessions();
    } catch (err) {
      console.error('Failed to create project:', err);
      row.remove();
    }
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      input.value = '';
      input.blur();
    }
  });
}

// --- New Session (inline) ---
async function startNewSession() {
  // Show new session row in current list
  const newRow = document.getElementById('new-session-row');
  if (newRow) newRow.style.display = 'flex';

  // Show config area
  const config = document.getElementById('new-session-config');
  if (config) config.classList.remove('hidden');

  // If we're in home view, switch to split view to show config
  if (state.activeView === 'home') {
    state.activeView = 'conversation';
    state.activeSessionId = null;
    dom.homeView.classList.add('hidden');
    dom.splitView.classList.remove('hidden');
    renderSidebar();
    // Clear panels
    dom.panelsContainer.innerHTML = '';
  }

  // Populate group dropdown from projects API
  const select = document.getElementById('config-group');
  if (select) {
    select.innerHTML = '<option value="">None</option>';
    try {
      const projects = await apiGetProjects();
      for (const [name] of Object.entries(projects)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
    } catch (err) {
      // Fallback to deriving from sessions
      const groups = [...new Set(state.sessions.map(s => s.group).filter(Boolean))];
      groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = g;
        select.appendChild(opt);
      });
    }

    // Pre-select current project if inside a project view
    if (state.activeGroup && select) {
      select.value = state.activeGroup;
      // Auto-fill the directory from the project's defaultDir
      try {
        const projects = await apiGetProjects();
        const dirInput = document.getElementById('config-dir');
        if (projects[state.activeGroup] && projects[state.activeGroup].defaultDir && dirInput && !dirInput.value.trim()) {
          dirInput.value = projects[state.activeGroup].defaultDir;
        }
      } catch { /* ignore */ }
    }

    // Auto-fill dir when a project is selected
    select.addEventListener('change', async () => {
      const dirInput = document.getElementById('config-dir');
      if (!dirInput || dirInput.value.trim()) return; // Don't override manual input
      const projectName = select.value;
      if (!projectName) return;
      try {
        const projects = await apiGetProjects();
        if (projects[projectName] && projects[projectName].defaultDir) {
          dirInput.value = projects[projectName].defaultDir;
        }
      } catch { /* ignore */ }
    });
  }

  // Focus name field
  setTimeout(() => {
    const nameInput = document.getElementById('config-name');
    if (nameInput) nameInput.focus();
  }, 50);
}

function cancelNewSession() {
  const newRow = document.getElementById('new-session-row');
  if (newRow) newRow.style.display = 'none';

  const config = document.getElementById('new-session-config');
  if (config) config.classList.add('hidden');

  // Clear inputs
  const nameInput = document.getElementById('config-name');
  const dirInput = document.getElementById('config-dir');
  const msgInput = document.getElementById('config-message');
  if (nameInput) nameInput.value = '';
  if (dirInput) dirInput.value = '';
  if (msgInput) msgInput.value = '';

  // If no active session, go back home
  if (!state.activeSessionId) {
    showHome();
  }
}

async function submitNewSession() {
  const nameInput = document.getElementById('config-name');
  const groupSelect = document.getElementById('config-group');
  const dirInput = document.getElementById('config-dir');
  const msgInput = document.getElementById('config-message');
  const startBtn = document.getElementById('config-start');

  const message = msgInput ? msgInput.value.trim() : '';
  let name = nameInput ? nameInput.value.trim() : '';

  // Auto-generate name from message if empty
  if (!name && message) {
    name = message.split(/\s+/).slice(0, 4).join(' ');
  }
  name = name || 'Untitled';

  const group = groupSelect ? groupSelect.value : null;
  const dir = dirInput ? dirInput.value.trim() : undefined;

  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
  }

  try {
    const session = await apiCreateSession(name, group || null, dir || undefined);
    session.unread = false;
    state.sessions.unshift(session);

    cancelNewSession();
    openConversation(session.id);

    // Send initial message after pty initializes
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
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
    }
  }
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
let lastSessionsHash = '';
let lastProjectsHash = '';

async function fetchAndUpdateSessions() {
  try {
    const [serverSessions, projects] = await Promise.all([
      apiGetSessions(),
      apiGetProjects(),
    ]);

    // Quick hash to detect changes: compare JSON length + first/last IDs + activity times
    const sessHash = serverSessions.length + ':' +
      (serverSessions[0]?.id || '') + ':' +
      (serverSessions[0]?.lastActivity || '') + ':' +
      (serverSessions[0]?.status || '');
    const projHash = JSON.stringify(projects);

    const changed = sessHash !== lastSessionsHash || projHash !== lastProjectsHash;
    lastSessionsHash = sessHash;
    lastProjectsHash = projHash;

    state.projects = projects;
    // Merge server data with local unread state
    const unreadMap = new Map();
    for (const s of state.sessions) {
      unreadMap.set(s.id, s.unread || false);
    }
    state.sessions = serverSessions.map(s => ({
      ...s,
      unread: unreadMap.has(s.id) ? unreadMap.get(s.id) : false,
    }));

    if (changed) {
      refreshActiveView();
    }
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

// --- Context Menu ---
function showContextMenu(sessionId, x, y) {
  const menu = document.getElementById('context-menu');
  const session = state.sessions.find(s => s.id === sessionId);
  if (!menu || !session) return;

  contextMenuTarget = sessionId;

  // Update pin button text
  const pinBtn = menu.querySelector('[data-action="pin"]');
  if (pinBtn) pinBtn.textContent = session.pinned ? 'Unpin' : 'Pin';

  // Update archive button text
  const archiveBtn = menu.querySelector('[data-action="archive"]');
  if (archiveBtn) archiveBtn.textContent = session.archived ? 'Unarchive' : 'Archive';

  // Position menu
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
  menu.classList.remove('hidden');

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu() {
  const menu = document.getElementById('context-menu');
  const picker = document.getElementById('project-picker');
  if (menu) menu.classList.add('hidden');
  if (picker) picker.classList.add('hidden');
  contextMenuTarget = null;
}

function handleContextMenuAction(action) {
  const sessionId = contextMenuTarget;
  if (!sessionId) return;

  closeContextMenu();

  switch (action) {
    case 'rename':
      startInlineRename(sessionId);
      break;
    case 'pin':
      togglePin(sessionId);
      break;
    case 'assign-project':
      showProjectPicker(sessionId);
      break;
    case 'archive':
      toggleArchive(sessionId);
      break;
  }
}

async function togglePin(sessionId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return;
  const newPinned = !session.pinned;
  try {
    await apiUpdateSessionMeta(sessionId, { pinned: newPinned });
    session.pinned = newPinned;
    refreshActiveView();
  } catch (err) {
    console.error('Failed to toggle pin:', err);
  }
}

async function toggleArchive(sessionId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return;
  try {
    await apiUpdateSessionMeta(sessionId, { archived: true });
    state.sessions = state.sessions.filter(s => s.id !== sessionId);
    // If we archived the active session, go home or remove from panels
    if (state.activeSessionId === sessionId) {
      if (state.panels.length > 1) {
        removePanel(sessionId);
      } else {
        showHome();
      }
    }
    refreshActiveView();
  } catch (err) {
    console.error('Failed to archive:', err);
  }
}

async function showProjectPicker(sessionId) {
  const picker = document.getElementById('project-picker');
  if (!picker) return;

  // Re-open context menu target so action can reference the session
  contextMenuTarget = sessionId;

  try {
    const projects = await apiGetProjects();
    picker.innerHTML = '';

    // "None" option
    const noneBtn = document.createElement('button');
    noneBtn.className = 'context-menu-item';
    noneBtn.textContent = 'None';
    noneBtn.addEventListener('click', async () => {
      await apiUpdateSessionMeta(sessionId, { project: null });
      picker.classList.add('hidden');
      fetchAndUpdateSessions();
    });
    picker.appendChild(noneBtn);

    // Project options
    for (const [name, project] of Object.entries(projects)) {
      const btn = document.createElement('button');
      btn.className = 'context-menu-item';
      btn.innerHTML = `<span style="color: ${escapeHtml(project.color || '#636366')}; margin-right: 6px;">&#9679;</span> ${escapeHtml(name)}`;
      btn.addEventListener('click', async () => {
        await apiUpdateSessionMeta(sessionId, { project: name });
        picker.classList.add('hidden');
        fetchAndUpdateSessions();
      });
      picker.appendChild(btn);
    }

    // Position near context menu
    const menu = document.getElementById('context-menu');
    if (menu) {
      const menuRect = menu.getBoundingClientRect();
      picker.style.left = `${menuRect.right + 4}px`;
      picker.style.top = `${menuRect.top}px`;
    }
    picker.classList.remove('hidden');

    // Close picker on outside click
    setTimeout(() => {
      document.addEventListener('click', () => {
        picker.classList.add('hidden');
      }, { once: true });
    }, 0);
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

// --- Project Context Menu ---
let projectContextTarget = null;

function showProjectContextMenu(projectName, x, y) {
  const menu = document.getElementById('project-context-menu');
  if (!menu) return;

  projectContextTarget = projectName;
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 150)}px`;
  menu.classList.remove('hidden');

  setTimeout(() => {
    document.addEventListener('click', closeProjectContextMenu, { once: true });
  }, 0);
}

function closeProjectContextMenu() {
  const menu = document.getElementById('project-context-menu');
  if (menu) menu.classList.add('hidden');
  projectContextTarget = null;
}

function handleProjectContextAction(action) {
  const name = projectContextTarget;
  if (!name) return;
  closeProjectContextMenu();

  switch (action) {
    case 'rename-project':
      startProjectRename(name);
      break;
    case 'delete-project':
      deleteProject(name);
      break;
  }
}

async function deleteProject(name) {
  try {
    await apiDeleteProject(name);
    await fetchAndUpdateSessions();
  } catch (err) {
    console.error('Failed to delete project:', err);
  }
}

function startProjectRename(name) {
  // Find the project row with this name
  const rows = dom.dashboardProjects.querySelectorAll('.project-row');
  let targetRow = null;
  for (const row of rows) {
    const nameEl = row.querySelector('.project-row-name');
    if (nameEl && nameEl.textContent.trim() === name) {
      targetRow = row;
      break;
    }
  }
  if (!targetRow) return;

  const nameEl = targetRow.querySelector('.project-row-name');
  const colorDot = nameEl.querySelector('.project-color-dot');
  const originalHtml = nameEl.innerHTML;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = name;

  nameEl.innerHTML = '';
  if (colorDot) nameEl.appendChild(colorDot.cloneNode(true));
  nameEl.appendChild(input);
  input.focus();
  input.select();

  async function commit() {
    const newName = input.value.trim();
    if (newName && newName !== name) {
      try {
        await fetch(`/projects/${encodeURIComponent(name)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
        await fetchAndUpdateSessions();
      } catch (err) {
        console.error('Failed to rename project:', err);
        nameEl.innerHTML = originalHtml;
      }
    } else {
      nameEl.innerHTML = originalHtml;
    }
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = name; input.blur(); }
  });
}

// --- Inline Rename ---
function startInlineRename(sessionId) {
  // Find the session name element in sidebar or recent list
  const row = document.querySelector(`.session-row[data-session-id="${sessionId}"] .session-row-name`)
    || document.querySelector(`.recent-row[data-session-id="${sessionId}"] .recent-row-name`);
  if (!row) return;

  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return;

  const currentName = session.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = currentName;

  // Replace text with input
  const originalContent = row.innerHTML;
  row.innerHTML = '';
  row.appendChild(input);
  input.focus();
  input.select();

  async function commitRename() {
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      try {
        await apiUpdateSessionMeta(sessionId, { customName: newName });
        session.name = newName;
      } catch (err) {
        console.error('Failed to rename:', err);
      }
    }
    // Restore (will be updated on next render)
    row.innerHTML = originalContent;
    if (newName && newName !== currentName) {
      row.textContent = newName;
    }
    refreshActiveView();
  }

  input.addEventListener('blur', commitRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      input.value = currentName;
      input.blur();
    }
  });
}

// --- Event Listeners ---
function initEventListeners() {
  // Back button
  dom.backBtn.addEventListener('click', showHome);

  // New session — both the hidden toolbar button and the floating FAB
  dom.newSessionBtn.addEventListener('click', startNewSession);
  const composeFab = document.getElementById('compose-fab');
  if (composeFab) {
    composeFab.addEventListener('click', startNewSession);
  }

  // New project — "+" button next to PROJECTS label
  const addProjectBtn = document.getElementById('add-project-btn');
  if (addProjectBtn) {
    addProjectBtn.addEventListener('click', startNewProject);
  }

  // New session config
  const configStart = document.getElementById('config-start');
  if (configStart) {
    configStart.addEventListener('click', submitNewSession);
  }

  const configMessage = document.getElementById('config-message');
  if (configMessage) {
    configMessage.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitNewSession();
      }
    });
  }

  // Search inputs
  dom.homeSearch.addEventListener('input', (e) => handleSearch(e.target.value));
  dom.sidebarSearch.addEventListener('input', (e) => handleSearch(e.target.value));

  // Context menu actions (sessions)
  const contextMenu = document.getElementById('context-menu');
  if (contextMenu) {
    contextMenu.querySelectorAll('.context-menu-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleContextMenuAction(btn.dataset.action);
      });
    });
  }

  // Context menu actions (projects)
  const projMenu = document.getElementById('project-context-menu');
  if (projMenu) {
    projMenu.querySelectorAll('.context-menu-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleProjectContextAction(btn.dataset.action);
      });
    });
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;

    // Cmd+N -> new session
    if (meta && e.key === 'n') {
      e.preventDefault();
      startNewSession();
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
      closeContextMenu();
      closeProjectContextMenu();
      const config = document.getElementById('new-session-config');
      if (config && !config.classList.contains('hidden')) {
        cancelNewSession();
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
  // Resolve DOM refs that require the document to be ready
  dom.dashboardProjects = $('#dashboard-projects');
  dom.dashboardRecent = $('#dashboard-recent');
  dom.sidebarHeaderTitle = $('#sidebar-header-title');

  initEventListeners();
  startPolling();
}

document.addEventListener('DOMContentLoaded', init);
