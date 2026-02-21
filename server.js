const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const url = require('url');
const { execSync } = require('child_process');

// ── Ensure claude and other tools are in PATH ───────────────────────────────
const HOME = process.env.HOME || '/Users/maxwraae';
const extraPaths = [
  path.join(HOME, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
];
const currentPath = process.env.PATH || '';
for (const p of extraPaths) {
  if (!currentPath.includes(p)) {
    process.env.PATH = p + ':' + process.env.PATH;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects');
const SCROLLBACK_SIZE = 100 * 1024; // 100KB circular buffer per session
const IDLE_TIMEOUT_MS = 30 * 1000; // 30 seconds no output = idle
const STATUS_CHECK_INTERVAL_MS = 5000; // Check status every 5 seconds
const SESSION_CACHE_TTL_MS = 5000; // Re-read from disk every 5 seconds
const ANSI_STRIP_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;

// ── Metadata layer ───────────────────────────────────────────────────────────

const META_DIR = path.join(process.env.HOME, '.config', 'aimessage');
const META_FILE = path.join(META_DIR, 'meta.json');

const PROJECT_COLORS = [
  '#FF6B6B', '#FF9F43', '#FECA57', '#48DBFB', '#0ABDE3',
  '#1DD1A1', '#00D2D3', '#54A0FF', '#5F27CD', '#C44569',
  '#F78FB3', '#3DC1D3', '#E77F67', '#778BEB', '#786FA6'
];

function ensureMetaDir() {
  if (!fs.existsSync(META_DIR)) {
    fs.mkdirSync(META_DIR, { recursive: true });
  }
}

function loadMeta() {
  try {
    if (!fs.existsSync(META_FILE)) {
      return { version: 1, projects: {}, sessions: {} };
    }
    const raw = fs.readFileSync(META_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load meta.json:', err.message);
    return { version: 1, projects: {}, sessions: {} };
  }
}

function saveMeta(meta) {
  ensureMetaDir();
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save meta.json:', err.message);
  }
}

// ── State ────────────────────────────────────────────────────────────────────

// activeSessions: Map<sessionId, sessionObject> — runtime state for sessions we've spawned
const activeSessions = new Map();
// ptyProcesses: Map<sessionId, ptyProcess>
const ptyProcesses = new Map();
// scrollbackBuffers: Map<sessionId, Buffer> — circular buffer of raw pty output
const scrollbackBuffers = new Map();
// wsClients: Map<sessionId, Set<WebSocket>>
const wsClients = new Map();
// Activity tracking for status detection
const lastOutputTime = new Map();
const lastInputTime = new Map();

// ── Session index cache ──────────────────────────────────────────────────────

let sessionCache = null;
let sessionCacheTime = 0;

function stripSummaryMarkdown(summary) {
  if (!summary) return summary;
  // Strip ```json\n{"title": "..."}``` wrapping
  const jsonMatch = summary.match(/^```(?:json)?\s*\n?\{[\s\S]*?"title"\s*:\s*"([^"]+)"[\s\S]*?\}\s*\n?```$/);
  if (jsonMatch) return jsonMatch[1];
  // Strip plain ``` wrapping
  const plainMatch = summary.match(/^```[\s\S]*?\n([\s\S]*?)\n?```$/);
  if (plainMatch) return plainMatch[1].trim();
  return summary;
}

function deriveGroupName(projectPath) {
  if (!projectPath) return null;
  const home = process.env.HOME || '/Users/maxwraae';
  if (projectPath === home) return null; // Home dir sessions are ungrouped
  const relative = projectPath.replace(home, '').replace(/^\//, '');
  const segments = relative.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.length === 1) return segments[0];
  // For deep paths like Library/CloudStorage/.../CV-Resume, use last segment
  return segments[segments.length - 1];
}

function deriveStatus(entry) {
  // If we have an active pty for this session, use real-time status
  if (activeSessions.has(entry.sessionId)) {
    return activeSessions.get(entry.sessionId).status;
  }

  const now = Date.now();
  const modified = new Date(entry.modified).getTime();
  const age = now - modified;

  if (age < 60000) return 'running';    // Modified < 1 min ago
  if (age < 300000) return 'done';       // Modified < 5 min ago
  return 'idle';                          // Older than 5 min
}

function extractSessionMetadata(jsonlPath, sessionId) {
  try {
    // Read only the first ~10KB of the file to avoid loading large files
    const READ_LIMIT = 10 * 1024;
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(READ_LIMIT);
    const bytesRead = fs.readSync(fd, buf, 0, READ_LIMIT, 0);
    fs.closeSync(fd);

    const chunk = buf.slice(0, bytesRead).toString('utf-8');
    const lines = chunk.split('\n');

    let firstPrompt = null;
    let created = null;
    let isSidechain = false;
    let projectPath = null;
    let messageCount = 0;
    let seenIsSidechain = false;

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // Skip malformed lines (last line may be partial)
      }

      // Capture isSidechain from any line that has it
      if (!seenIsSidechain && obj.isSidechain !== undefined) {
        isSidechain = !!obj.isSidechain;
        seenIsSidechain = true;
      }

      // Capture cwd (projectPath) from any line that has it
      if (!projectPath && obj.cwd) {
        projectPath = obj.cwd;
      }

      // Capture earliest timestamp as created
      if (obj.timestamp) {
        const t = new Date(obj.timestamp).getTime();
        if (!isNaN(t) && (created === null || t < created)) {
          created = t;
        }
      }

      // Count user/assistant messages
      if (obj.type === 'user' || obj.type === 'assistant') {
        messageCount++;
      }

      // Extract first user prompt
      if (!firstPrompt && obj.type === 'user' && obj.message) {
        const content = obj.message.content;
        if (typeof content === 'string') {
          firstPrompt = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block && block.type === 'text' && block.text) {
              firstPrompt = block.text;
              break;
            }
          }
        }
      }
    }

    const stat = fs.statSync(jsonlPath);
    const modified = stat.mtime.toISOString();

    return {
      sessionId,
      firstPrompt: firstPrompt ? firstPrompt.substring(0, 500) : null,
      created: created ? new Date(created).toISOString() : modified,
      modified,
      isSidechain,
      projectPath,
      summary: null,
      messageCount,
    };
  } catch (err) {
    console.error(`Failed to extract metadata from ${jsonlPath}:`, err.message);
    return null;
  }
}

function loadSessionIndex(includeArchived = false) {
  const now = Date.now();
  if (!includeArchived && sessionCache && now - sessionCacheTime < SESSION_CACHE_TTL_MS) {
    return sessionCache;
  }

  const allEntries = new Map(); // keyed by sessionId for deduplication

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch (err) {
    console.error('Failed to read Claude projects dir:', err.message);
    sessionCache = [];
    sessionCacheTime = now;
    return sessionCache;
  }

  for (const dir of projectDirs) {
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, dir);

    // Skip if not a directory
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const indexPath = path.join(projectDir, 'sessions-index.json');

    // First pass: read the sessions-index.json if it exists
    let indexMtime = 0;
    if (fs.existsSync(indexPath)) {
      try {
        indexMtime = fs.statSync(indexPath).mtimeMs;
        const raw = fs.readFileSync(indexPath, 'utf-8');
        const index = JSON.parse(raw);
        if (Array.isArray(index.entries)) {
          for (const entry of index.entries) {
            if (!entry.sessionId) continue;
            if (entry.isSidechain) continue;
            const fp = (entry.firstPrompt || '').toLowerCase();
            if (fp.startsWith('you are a memory extraction system')) continue;
            if (fp.startsWith('create these memory entities')) continue;
            if (fp.startsWith('no prompt') && !entry.summary) continue;
            if (entry.messageCount <= 1) continue;
            if (!allEntries.has(entry.sessionId)) {
              allEntries.set(entry.sessionId, entry);
            }
          }
        }
      } catch (err) {
        console.error(`Failed to parse ${indexPath}:`, err.message);
      }
    }

    // Second pass: scan for .jsonl files newer than the index
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const filename of dirEntries) {
      if (!filename.endsWith('.jsonl')) continue;

      const jsonlPath = path.join(projectDir, filename);
      let fileStat;
      try {
        fileStat = fs.statSync(jsonlPath);
      } catch {
        continue;
      }

      // Only process files newer than the index
      if (fileStat.mtimeMs <= indexMtime) continue;

      // Extract sessionId from filename (strip .jsonl extension)
      const sessionId = filename.slice(0, -6);

      // Skip if already indexed
      if (allEntries.has(sessionId)) continue;

      const meta = extractSessionMetadata(jsonlPath, sessionId);
      if (!meta) continue;
      if (meta.isSidechain) continue;

      const fp = (meta.firstPrompt || '').toLowerCase();
      if (fp.startsWith('you are a memory extraction system')) continue;
      if (fp.startsWith('create these memory entities')) continue;
      if (!meta.firstPrompt && !meta.summary) continue;
      if (meta.messageCount <= 1) continue;

      allEntries.set(sessionId, meta);
    }
  }

  const home = process.env.HOME || '/Users/maxwraae';

  const list = Array.from(allEntries.values()).map(entry => {
    const rawSummary = entry.summary || null;
    const cleanSummary = stripSummaryMarkdown(rawSummary);
    const name = cleanSummary
      || (entry.firstPrompt && entry.firstPrompt !== 'No prompt'
          ? entry.firstPrompt.substring(0, 50)
          : null)
      || 'Untitled';

    const preview = (entry.firstPrompt && entry.firstPrompt !== 'No prompt')
      ? entry.firstPrompt.trim().substring(0, 150)
      : '';

    // If we have an active session overriding some fields, merge them
    const active = activeSessions.get(entry.sessionId);

    return {
      id: entry.sessionId,
      name,
      group: null, // Only set from metadata; directory path available in workingDir
      status: deriveStatus(entry),
      createdAt: entry.created,
      lastActivity: active ? active.lastActivity : entry.modified,
      preview: active ? (active.preview || preview) : preview,
      workingDir: entry.projectPath,
      messageCount: entry.messageCount,
    };
  });

  // Merge metadata overlay
  const meta = loadMeta();

  const enriched = list.map(entry => {
    const sessionMeta = meta.sessions[entry.id] || {};

    // Apply custom name if set
    if (sessionMeta.customName) {
      entry.name = sessionMeta.customName;
    }

    // Apply project from metadata (overrides directory-derived group)
    if (sessionMeta.project) {
      entry.group = sessionMeta.project;
    }

    // Add pin/archive flags
    entry.pinned = sessionMeta.pinned || false;
    entry.archived = sessionMeta.archived || false;

    // Add project color if project exists in meta
    const projectMeta = meta.projects[entry.group];
    if (projectMeta) {
      entry.projectColor = projectMeta.color;
      entry.projectIcon = projectMeta.icon;
    }

    return entry;
  });

  // Filter out archived sessions by default
  const filtered = includeArchived ? enriched : enriched.filter(e => !e.archived);

  // Sort: pinned first, then by lastActivity
  filtered.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.lastActivity) - new Date(a.lastActivity);
  });

  if (!includeArchived) {
    sessionCache = filtered;
    sessionCacheTime = now;
  }
  return filtered;
}

function invalidateSessionCache() {
  sessionCacheTime = 0;
}

// ── Scrollback buffer ────────────────────────────────────────────────────────

function appendScrollback(id, data) {
  const buf = scrollbackBuffers.get(id) || Buffer.alloc(0);
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let combined = Buffer.concat([buf, chunk]);
  if (combined.length > SCROLLBACK_SIZE) {
    combined = combined.slice(combined.length - SCROLLBACK_SIZE);
  }
  scrollbackBuffers.set(id, combined);
}

// ── Preview text ─────────────────────────────────────────────────────────────

// Patterns that indicate terminal metadata rather than conversation content
const TERMINAL_JUNK_RE = /(\[ws-[0-9a-f]+|Claude Code"|\\x1b\[|\u001b\[|\[0,0\]|ESC\[|\[\d+,\d+\])/i;

function isTerminalMetadata(line) {
  if (!line || !line.trim()) return true;
  // tmux pane title format: [ws-<id>:...]
  if (/^\[ws-[0-9a-f]/.test(line)) return true;
  // Contains Claude Code terminal title
  if (/Claude Code"/.test(line)) return true;
  // Contains ANSI escape sequences (raw or unicode)
  if (/\x1b\[|\u001b\[/.test(line)) return true;
  // Contains terminal coordinate patterns like [0,0]
  if (/\[\d+,\d+\]/.test(line)) return true;
  // tmux status bar patterns
  if (/^\s*\d+:\d+\s*\[/.test(line)) return true;
  return false;
}

function updatePreview(id, rawData) {
  const session = activeSessions.get(id);
  if (!session) return;

  const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
  const stripped = text.replace(ANSI_STRIP_RE, '');
  const lines = stripped.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !isTerminalMetadata(l));

  if (lines.length > 0) {
    session.preview = lines[lines.length - 1].substring(0, 150);
  }
}

// ── tmux / pty ───────────────────────────────────────────────────────────────

function tmuxName(id) {
  return `ws-${id}`;
}

function tmuxSessionExists(id) {
  try {
    execSync(`tmux has-session -t ${tmuxName(id)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function reattachSession(id, workingDir) {
  if (!tmuxSessionExists(id)) return false;

  const cwd = workingDir || process.env.HOME;
  const cols = 200;
  const rows = 50;

  const proc = pty.spawn('tmux', ['attach-session', '-t', tmuxName(id)], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env,
  });

  ptyProcesses.set(id, proc);

  // Ensure active session tracking exists
  if (!activeSessions.has(id)) {
    activeSessions.set(id, {
      id,
      status: 'idle',
      lastActivity: new Date().toISOString(),
      preview: null,
      workingDir: cwd,
    });
  }

  setupPtyListeners(id, proc);
  lastOutputTime.set(id, Date.now());
  return true;
}

function spawnSession(id, workingDir) {
  const cols = 200;
  const rows = 50;
  const cwd = workingDir || process.env.HOME;
  const name = tmuxName(id);

  // Spawn tmux with claude inside via node-pty
  const proc = pty.spawn(
    'tmux',
    [
      'new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows),
      'claude', '--dangerously-skip-permissions',
    ],
    {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env,
    }
  );

  // tmux new-session -d exits immediately. Attach after a short delay.
  proc.onExit(() => {
    try { execSync(`tmux set-option -t "${name}" status off 2>/dev/null`); } catch (_) {}
    setTimeout(() => {
      const attachProc = pty.spawn('tmux', ['attach-session', '-t', name], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: process.env,
      });
      ptyProcesses.set(id, attachProc);
      setupPtyListeners(id, attachProc);
    }, 300);
  });
}

function setupPtyListeners(id, proc) {
  proc.onData((data) => {
    const session = activeSessions.get(id);
    if (!session) return;

    const now = Date.now();
    session.lastActivity = new Date().toISOString();
    session.status = 'running';
    lastOutputTime.set(id, now);

    appendScrollback(id, data);
    updatePreview(id, data);
    broadcastRaw(id, data);
  });

  proc.onExit(({ exitCode }) => {
    const session = activeSessions.get(id);
    if (session) {
      session.status = exitCode === 0 ? 'done' : 'error';
      session.lastActivity = new Date().toISOString();
    }
    ptyProcesses.delete(id);
    lastOutputTime.delete(id);
    lastInputTime.delete(id);
    invalidateSessionCache();

    const exitMsg = `\r\n\x1B[31m[Process exited with code ${exitCode}]\x1B[0m\r\n`;
    broadcastRaw(id, exitMsg);
  });
}

// ── Status detection (for active pty sessions) ───────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions) {
    if (session.status === 'done' || session.status === 'error') continue;
    if (!ptyProcesses.has(id)) {
      if (session.status !== 'error') {
        session.status = 'error';
      }
      continue;
    }

    const lastOut = lastOutputTime.get(id) || 0;
    const elapsed = now - lastOut;

    if (elapsed > IDLE_TIMEOUT_MS && session.status === 'running') {
      session.status = 'idle';
    }
  }
}, STATUS_CHECK_INTERVAL_MS);

// ── WebSocket broadcast ──────────────────────────────────────────────────────

function broadcastRaw(sessionId, data) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(buf);
    }
  }
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /sessions — List all sessions from Claude Code's native storage
app.get('/sessions', (req, res) => {
  const includeArchived = req.query.archived === 'true';
  const list = loadSessionIndex(includeArchived);
  res.json(list);
});

// GET /sessions/:id — Get single session
app.get('/sessions/:id', (req, res) => {
  const id = req.params.id;
  const list = loadSessionIndex();
  const session = list.find(s => s.id === id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});

// POST /sessions — Create a new session
app.post('/sessions', (req, res) => {
  const { name, group, workingDir, message } = req.body;

  const id = crypto.randomUUID();
  const cwd = workingDir || process.env.HOME;
  const now = new Date().toISOString();

  // Track in activeSessions for runtime state
  const session = {
    id,
    name: name || 'New Session',
    group: group || null,
    status: 'running',
    createdAt: now,
    lastActivity: now,
    preview: null,
    workingDir: cwd,
    messageCount: 0,
  };

  activeSessions.set(id, session);
  scrollbackBuffers.set(id, Buffer.alloc(0));
  wsClients.set(id, new Set());

  spawnSession(id, cwd);

  // Persist metadata if a project or custom name was specified
  if (group || (name && name !== 'New Session')) {
    const meta = loadMeta();
    meta.sessions[id] = meta.sessions[id] || {};
    if (group) {
      meta.sessions[id].project = group;
    }
    if (name && name !== 'New Session' && name !== 'Untitled') {
      meta.sessions[id].customName = name;
    }
    saveMeta(meta);
  }

  invalidateSessionCache();

  // Send initial message to pty after process starts
  if (message) {
    setTimeout(() => {
      const proc = ptyProcesses.get(id);
      if (proc) {
        proc.write(message + '\n');
      }
    }, 1500);
  }

  res.status(201).json(session);
});

// DELETE /sessions/:id — Kill session
app.delete('/sessions/:id', (req, res) => {
  const id = req.params.id;

  // Kill the pty process
  const proc = ptyProcesses.get(id);
  if (proc) {
    proc.kill();
    ptyProcesses.delete(id);
  }

  // Kill the tmux session
  try {
    execSync(`tmux kill-session -t ${tmuxName(id)} 2>/dev/null`);
  } catch {
    // Already dead, that's fine
  }

  // Close WebSocket connections
  const clients = wsClients.get(id);
  if (clients) {
    for (const ws of clients) {
      ws.close(1000, 'Session deleted');
    }
  }

  // Cleanup runtime state
  activeSessions.delete(id);
  scrollbackBuffers.delete(id);
  wsClients.delete(id);
  lastOutputTime.delete(id);
  lastInputTime.delete(id);
  invalidateSessionCache();

  res.json({ ok: true });
});

// PATCH /sessions/:id/meta — Update session metadata (custom name, project, pin, archive)
app.patch('/sessions/:id/meta', (req, res) => {
  const meta = loadMeta();
  const id = req.params.id;
  const updates = req.body; // { customName?, project?, pinned?, archived? }

  if (!meta.sessions[id]) {
    meta.sessions[id] = {};
  }

  // Only store non-null values (sparse storage)
  for (const [key, value] of Object.entries(updates)) {
    if (['customName', 'project', 'pinned', 'archived'].includes(key)) {
      if (value === null || value === undefined || value === '' || value === false) {
        delete meta.sessions[id][key];
      } else {
        meta.sessions[id][key] = value;
      }
    }
  }

  // Clean up empty session entries
  if (Object.keys(meta.sessions[id]).length === 0) {
    delete meta.sessions[id];
  }

  saveMeta(meta);
  invalidateSessionCache();
  res.json({ ok: true });
});

// GET /projects — List all projects
app.get('/projects', (req, res) => {
  const meta = loadMeta();
  res.json(meta.projects);
});

// POST /projects — Create a new project
app.post('/projects', (req, res) => {
  const { name, color, defaultDir, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const meta = loadMeta();
  meta.projects[name] = {
    color: color || PROJECT_COLORS[Object.keys(meta.projects).length % PROJECT_COLORS.length],
    defaultDir: defaultDir || process.env.HOME,
    icon: icon || name[0].toUpperCase(),
  };
  saveMeta(meta);
  invalidateSessionCache();
  res.json(meta.projects[name]);
});

// PATCH /projects/:name — Update project (rename, recolor, etc.)
app.patch('/projects/:name', (req, res) => {
  const meta = loadMeta();
  const oldName = req.params.name;
  if (!meta.projects[oldName]) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { name: newName, color, defaultDir, icon } = req.body;

  if (newName && newName !== oldName) {
    // Rename: move project and update all session references
    meta.projects[newName] = { ...meta.projects[oldName] };
    delete meta.projects[oldName];
    for (const session of Object.values(meta.sessions)) {
      if (session.project === oldName) {
        session.project = newName;
      }
    }
  }

  const target = meta.projects[newName || oldName];
  if (color) target.color = color;
  if (defaultDir) target.defaultDir = defaultDir;
  if (icon) target.icon = icon;

  saveMeta(meta);
  invalidateSessionCache();
  res.json(target);
});

// DELETE /projects/:name — Delete project (ungroups its sessions)
app.delete('/projects/:name', (req, res) => {
  const meta = loadMeta();
  const name = req.params.name;
  if (!meta.projects[name]) {
    return res.status(404).json({ error: 'Project not found' });
  }

  delete meta.projects[name];

  // Remove project references from sessions
  for (const session of Object.values(meta.sessions)) {
    if (session.project === name) {
      delete session.project;
    }
  }

  saveMeta(meta);
  invalidateSessionCache();
  res.json({ ok: true });
});

// SPA catch-all: serve index.html for client-side routes
app.get('/session/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/project/:name', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle upgrade for WebSocket
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  const match = pathname.match(/^\/sessions\/([^/]+)\/stream$/);

  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];

  // Session must exist in index or active sessions
  const list = loadSessionIndex();
  const sessionExists = list.some(s => s.id === sessionId) || activeSessions.has(sessionId);

  if (!sessionExists) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, sessionId);
  });
});

wss.on('connection', (ws, request, sessionId) => {
  // Register this client
  let clients = wsClients.get(sessionId);
  if (!clients) {
    clients = new Set();
    wsClients.set(sessionId, clients);
  }
  clients.add(ws);

  console.log(`WebSocket connected to session ${sessionId} (${clients.size} clients)`);

  // If no active pty for this session, try to attach
  if (!ptyProcesses.has(sessionId)) {
    if (tmuxSessionExists(sessionId)) {
      // Reattach to existing tmux session
      const list = loadSessionIndex();
      const entry = list.find(s => s.id === sessionId);
      const workingDir = entry ? entry.workingDir : process.env.HOME;
      reattachSession(sessionId, workingDir);
    } else {
      // Spawn a new claude --resume session
      const list = loadSessionIndex();
      const entry = list.find(s => s.id === sessionId);
      const cwd = entry ? (entry.workingDir || process.env.HOME) : process.env.HOME;
      const name = tmuxName(sessionId);
      const cols = 200;
      const rows = 50;

      if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, {
          id: sessionId,
          status: 'running',
          lastActivity: new Date().toISOString(),
          preview: null,
          workingDir: cwd,
        });
      }
      if (!scrollbackBuffers.has(sessionId)) {
        scrollbackBuffers.set(sessionId, Buffer.alloc(0));
      }

      const spawnProc = pty.spawn(
        'tmux',
        [
          'new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows),
          'claude', '--resume', sessionId, '--dangerously-skip-permissions',
        ],
        { name: 'xterm-256color', cols, rows, cwd, env: process.env }
      );

      spawnProc.onExit(() => {
        try { execSync(`tmux set-option -t "${name}" status off 2>/dev/null`); } catch (_) {}
        setTimeout(() => {
          const attachProc = pty.spawn('tmux', ['attach-session', '-t', name], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: process.env,
          });
          ptyProcesses.set(sessionId, attachProc);
          setupPtyListeners(sessionId, attachProc);
        }, 300);
      });
    }
  }

  // Send scrollback buffer for reconnection
  const scrollback = scrollbackBuffers.get(sessionId);
  if (scrollback && scrollback.length > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(scrollback);
  }

  // Handle incoming messages — raw keystrokes or resize commands
  ws.on('message', (data) => {
    const message = data.toString();

    // Check if this is a resize command
    if (message.charAt(0) === '{' && message.includes('"type"') && message.includes('"resize"')) {
      try {
        const cmd = JSON.parse(message);
        if (cmd.type === 'resize' && cmd.cols && cmd.rows) {
          const proc = ptyProcesses.get(sessionId);
          if (proc) {
            proc.resize(cmd.cols, cmd.rows);
          }
          try {
            execSync(`tmux resize-window -t ${tmuxName(sessionId)} -x ${cmd.cols} -y ${cmd.rows} 2>/dev/null`);
          } catch {
            // tmux resize may fail if session doesn't exist, that's ok
          }
          return;
        }
      } catch {
        // Not valid JSON — fall through to write as raw input
      }
    }

    // Raw keystroke input — write directly to pty stdin
    const proc = ptyProcesses.get(sessionId);
    if (proc) {
      proc.write(message);

      const session = activeSessions.get(sessionId);
      if (session) {
        session.lastActivity = new Date().toISOString();
        session.status = 'running';
        lastInputTime.set(sessionId, Date.now());
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`WebSocket disconnected from session ${sessionId} (${clients.size} clients remaining)`);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error on session ${sessionId}:`, err.message);
    clients.delete(ws);
  });
});

// ── Startup ──────────────────────────────────────────────────────────────────

function autoDiscoverProjects() {
  const meta = loadMeta();
  const sessions = loadSessionIndex(true); // include archived
  const groups = new Map();

  for (const session of sessions) {
    if (session.group && !meta.projects[session.group]) {
      if (!groups.has(session.group)) {
        groups.set(session.group, session.workingDir);
      }
    }
  }

  if (groups.size > 0) {
    for (const [name, dir] of groups) {
      let hash = 0;
      for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
      }
      meta.projects[name] = {
        color: PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length],
        defaultDir: dir || process.env.HOME,
        icon: name[0].toUpperCase(),
      };
    }
    saveMeta(meta);
    console.log(`Auto-discovered ${groups.size} projects: ${[...groups.keys()].join(', ')}`);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`aiMessage server listening on http://${HOST}:${PORT}`);
  console.log(`Reading sessions from: ${CLAUDE_PROJECTS_DIR}`);
  const sessions = loadSessionIndex();
  console.log(`Sessions found: ${sessions.length}`);
  // autoDiscoverProjects(); // Disabled: projects are created explicitly by user
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  console.log('\nShutting down...');

  // Close WebSocket connections
  for (const [, clients] of wsClients) {
    for (const ws of clients) {
      ws.close(1000, 'Server shutting down');
    }
  }

  // Close pty attachments (but NOT tmux sessions — they persist)
  for (const [, proc] of ptyProcesses) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  // Close HTTP server
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });

  // Force exit after 5s
  setTimeout(() => {
    console.log('Forcing exit.');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
