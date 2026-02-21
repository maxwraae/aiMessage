const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const url = require('url');

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SCROLLBACK_SIZE = 100 * 1024; // 100KB circular buffer per session
const IDLE_TIMEOUT_MS = 30 * 1000; // 30 seconds no output = idle
const STATUS_CHECK_INTERVAL_MS = 5000; // Check status every 5 seconds
const ANSI_STRIP_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;

// ── State ───────────────────────────────────────────────────────────────────

// session: { id, name, group, status, createdAt, lastActivity, preview, workingDir }
const sessions = new Map();
// ptyProcesses: Map<sessionId, ptyProcess>
const ptyProcesses = new Map();
// scrollbackBuffers: Map<sessionId, Buffer> — circular buffer of raw pty output
const scrollbackBuffers = new Map();
// wsClients: Map<sessionId, Set<WebSocket>>
const wsClients = new Map();
// Activity tracking for status detection
const lastOutputTime = new Map();
const lastInputTime = new Map();

// ── Persistence ─────────────────────────────────────────────────────────────

function saveSessions() {
  const data = {};
  for (const [id, session] of sessions) {
    data[id] = session;
  }
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save sessions:', err.message);
  }
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      for (const [id, session] of Object.entries(data)) {
        // Mark previously running sessions as idle on restart
        if (session.status === 'running') {
          session.status = 'idle';
        }
        sessions.set(id, session);
        scrollbackBuffers.set(id, Buffer.alloc(0));
        wsClients.set(id, new Set());
        // Try to reattach to existing tmux sessions
        reattachSession(id);
      }
    }
  } catch (err) {
    console.error('Failed to load sessions:', err.message);
  }
}

// ── Scrollback buffer ───────────────────────────────────────────────────────

function appendScrollback(id, data) {
  const buf = scrollbackBuffers.get(id) || Buffer.alloc(0);
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let combined = Buffer.concat([buf, chunk]);
  if (combined.length > SCROLLBACK_SIZE) {
    combined = combined.slice(combined.length - SCROLLBACK_SIZE);
  }
  scrollbackBuffers.set(id, combined);
}

// ── Preview text ────────────────────────────────────────────────────────────

function updatePreview(id, rawData) {
  const session = sessions.get(id);
  if (!session) return;

  const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
  const stripped = text.replace(ANSI_STRIP_RE, '');
  const lines = stripped.split('\n').filter(l => l.trim().length > 0);
  if (lines.length > 0) {
    session.preview = lines[lines.length - 1].trim().substring(0, 200);
  }
}

// ── tmux / pty ──────────────────────────────────────────────────────────────

function tmuxName(id) {
  return `ws-${id}`;
}

function tmuxSessionExists(id) {
  try {
    const { execSync } = require('child_process');
    execSync(`tmux has-session -t ${tmuxName(id)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function reattachSession(id) {
  if (!tmuxSessionExists(id)) {
    // tmux session is gone — mark as error
    const session = sessions.get(id);
    if (session) {
      session.status = 'error';
    }
    return;
  }

  // Attach to existing tmux session via node-pty
  const session = sessions.get(id);
  const cols = 200;
  const rows = 50;

  const proc = pty.spawn('tmux', ['attach-session', '-t', tmuxName(id)], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: session.workingDir || process.env.HOME,
    env: process.env,
  });

  ptyProcesses.set(id, proc);
  setupPtyListeners(id, proc);
  session.status = 'idle';
  lastOutputTime.set(id, Date.now());
}

function spawnSession(id, workingDir) {
  const cols = 200;
  const rows = 50;
  const cwd = workingDir || process.env.HOME;
  const name = tmuxName(id);

  // Spawn tmux with raw claude inside via node-pty
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

  // The above creates the tmux session detached then exits.
  // We need a small delay then attach to it.
  proc.onExit(() => {
    // tmux new-session -d exits immediately. Now attach.
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
    const session = sessions.get(id);
    if (!session) return;

    const now = Date.now();
    session.lastActivity = new Date().toISOString();
    session.status = 'running';
    lastOutputTime.set(id, now);

    // Append to scrollback buffer
    appendScrollback(id, data);

    // Update preview text
    updatePreview(id, data);

    // Broadcast raw data to connected WebSocket clients
    broadcastRaw(id, data);
  });

  proc.onExit(({ exitCode }) => {
    const session = sessions.get(id);
    if (session) {
      session.status = exitCode === 0 ? 'done' : 'error';
      session.lastActivity = new Date().toISOString();
      saveSessions();
    }
    ptyProcesses.delete(id);
    lastOutputTime.delete(id);
    lastInputTime.delete(id);

    // Notify connected clients that the process exited
    const exitMsg = `\r\n\x1B[31m[Process exited with code ${exitCode}]\x1B[0m\r\n`;
    broadcastRaw(id, exitMsg);
  });
}

// ── Status detection ────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.status === 'done' || session.status === 'error') continue;
    if (!ptyProcesses.has(id)) {
      if (session.status !== 'error') {
        session.status = 'error';
        saveSessions();
      }
      continue;
    }

    const lastOut = lastOutputTime.get(id) || 0;
    const elapsed = now - lastOut;

    if (elapsed > IDLE_TIMEOUT_MS && session.status === 'running') {
      session.status = 'idle';
      saveSessions();
    }
  }
}, STATUS_CHECK_INTERVAL_MS);

// ── WebSocket broadcast ─────────────────────────────────────────────────────

function broadcastRaw(sessionId, data) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  // Send as binary buffer to preserve ANSI codes
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(buf);
    }
  }
}

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /sessions — Create a new session
app.post('/sessions', (req, res) => {
  const { name, group, workingDir } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const id = crypto.randomUUID();
  const session = {
    id,
    name,
    group: group || null,
    status: 'running',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    preview: null,
    workingDir: workingDir || process.env.HOME,
  };

  sessions.set(id, session);
  scrollbackBuffers.set(id, Buffer.alloc(0));
  wsClients.set(id, new Set());

  spawnSession(id, session.workingDir);
  saveSessions();

  res.status(201).json(session);
});

// GET /sessions — List all sessions
app.get('/sessions', (req, res) => {
  const list = [];
  for (const session of sessions.values()) {
    list.push(session);
  }
  // Sort by lastActivity descending
  list.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  res.json(list);
});

// GET /sessions/:id — Get single session
app.get('/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});

// DELETE /sessions/:id — Kill session
app.delete('/sessions/:id', (req, res) => {
  const id = req.params.id;
  const session = sessions.get(id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Kill the pty process
  const proc = ptyProcesses.get(id);
  if (proc) {
    proc.kill();
    ptyProcesses.delete(id);
  }

  // Kill the tmux session
  try {
    const { execSync } = require('child_process');
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

  // Cleanup
  sessions.delete(id);
  scrollbackBuffers.delete(id);
  wsClients.delete(id);
  lastOutputTime.delete(id);
  lastInputTime.delete(id);

  saveSessions();
  res.json({ ok: true });
});

// ── HTTP + WebSocket server ─────────────────────────────────────────────────

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
  const session = sessions.get(sessionId);

  if (!session) {
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

  // Send scrollback buffer for reconnection — replay terminal history
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
          // Also resize the tmux window
          try {
            const { execSync } = require('child_process');
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

      // Update session activity
      const session = sessions.get(sessionId);
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

// ── Startup ─────────────────────────────────────────────────────────────────

loadSessions();

server.listen(PORT, HOST, () => {
  console.log(`aiMessage server listening on http://${HOST}:${PORT}`);
  console.log(`Sessions loaded: ${sessions.size}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────

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

  // Save state
  saveSessions();

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
