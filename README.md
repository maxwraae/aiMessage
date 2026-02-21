# aiMessage

iMessage for Claude Code sessions. A browser-based interface that embeds real Claude Code terminals with a Messages-style navigation shell.

## What It Is

A web app that wraps Claude Code sessions in a clean UI. Each session is a real terminal (xterm.js) connected to Claude Code running in tmux. The sidebar gives you session management, grouping, and status at a glance.

- **Real terminals** — not chat bubbles. Full ANSI rendering, cursor movement, colors. You type directly into Claude.
- **Session persistence** — tmux keeps sessions alive. Close your browser, reopen, pick up where you left off.
- **Multi-panel** — open 2-4 sessions side by side. Each panel is an independent terminal.
- **Groups** — organize sessions by project.
- **Mobile ready** — responsive layout works on phone via `macmini.local:8080`.

## Architecture

```
Safari (Mac/Phone)
    ↕ WebSocket (raw pty data)
Node.js + Express + ws
    ↕ node-pty
tmux sessions
    ↕
claude --dangerously-skip-permissions
```

## Setup

```bash
# Prerequisites
brew install tmux
npm install -g @anthropic-ai/claude-code

# Install
git clone https://github.com/maxwraae/aiMessage.git
cd aiMessage
npm install

# Run
npm start
# Open http://localhost:8080
```

## Usage

- **New session** — Click + or Cmd+N. Name it, optionally assign a group, type your first message.
- **Switch sessions** — Click in the sidebar.
- **Split view** — Hover a session card, click the [+] button to open alongside. Or Cmd+\.
- **Focus mode** — Click "Focus" to collapse back to single panel.
- **Search** — Cmd+K.
- **Interrupt Claude** — Cmd+. sends Ctrl+C.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Cmd+N | New session |
| Cmd+K | Search |
| Cmd+1-9 | Jump to session |
| Cmd+\ | Toggle split |
| Cmd+Shift+\ | Add panel |
| Cmd+W | Close panel |
| Cmd+. | Interrupt (Ctrl+C) |
| Escape | Back |

## Requirements

- macOS (uses node-pty)
- Node.js 18+
- tmux
- Claude Code CLI

## License

MIT
