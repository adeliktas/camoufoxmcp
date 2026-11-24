# Camofox Browser — MCP + Local Ops Patchset

Adapted patchset for running the [camofox-browser](https://github.com/jo-inc/camofox-browser) REST server with an MCP proxy for AI agents (Claude Code, Codex, Cursor, opencode).

**Original upstream**: MIT licensed by [Jo, Inc](https://github.com/jo-inc/camofox-browser).  
**This patchset**: MIT (same). Patches here are additions to the upstream repo; they do not alter upstream code.

---

## Architecture

```
┌─────────────────────────────────┐     ┌──────────────────────────┐
│  AI Agent (Claude, Cursor, ...) │     │  camofox-browser REST    │
│         MCP client              │────▶│  Server (Python/Node)    │
│         MCP proxy (Node)        │     │  (Docker on WSL2 / Linux)│
└─────────────────────────────────┘     └──────────────────────────┘
```

The MCP server is a **stateless proxy**. The browser is owned by the camofox-browser REST server which runs as a persistent background process. One browser, many agent sessions.

---

## Quick Start (Windows 10/11)

### 1. Prerequisites

| Component | Requirement |
|-----------|------------|
| Docker | Docker Desktop 4.x+ with WSL2 backend |
| Node.js | 22.x or newer (https://nodejs.org) |
| camofox-browser | Upstream repo (`jo-inc/camofox-browser`) |

### 2. Set up camofox-browser on Windows

```powershell
# Clone upstream
git clone https://github.com/jo-inc/camofox-browser.git
cd camofox-browser

# Build + start (downloads Camoufox + yt-dlp, builds Docker image)
.\build.ps1 build
.\build.ps1 up

# Verify it's running
curl -s http://localhost:9377/health
```

This builds a Docker image with Camoufox inside WSL2 and exposes the REST API on `http://localhost:9377`.

**Stop later:**
```powershell
.\build.ps1 down
```

### 3. Set up the MCP proxy

```powershell
cd mcp
npm install

# Test with default config (port 9377 on localhost)
node server.mjs
```

The server starts on stdio. Configure it in your MCP client:

```json
{
  "mcpServers": {
    "camoufox": {
      "command": "node",
      "args": ["C:\\path\\to\\camofox-browser\\mcp\\server.mjs"],
      "env": {
        "CAMOFOX_PORT": "9377",
        "CAMOFOX_USER_ID": "default"
      }
    }
  }
}
```

### 4. Verify end-to-end

Run the selfcheck (Node.js, no deps beyond mcp/):
```powershell
node local/selfcheck.mjs
```

---

## Environment Variables

All env vars are set in `local/camofox.env` and sourced by the ctl scripts.  
Key variables (defaults shown):

| Variable | Default | Description |
|----------|---------|-------------|
| `CAMOFOX_PORT` | `8788` | REST server port (use `9377` for Docker) |
| `CAMOFOX_BIND_HOST` | `127.0.0.1` | Bind address |
| `CAMOFOX_USER_ID` | `pi` | Browser identity partition (cookies per user) |
| `CAMOFOX_INTERACTIVE` | `off` | `desktop` opens visible window; `off` = headless |
| `CAMOFOX_PROFILE_DIR` | `$HOME/.local/share/camofox-browser/profiles` | Browser profile directory |
| `CAMOFOX_COOKIES_DIR` | `$HOME/.local/share/camofox-browser/cookies` | Cookie storage |
| `CAMOFOX_STATE_DIR` | `$HOME/.local/share/camofox-browser` | State directory |

**Windows note**: In `camofox.env` on Windows, replace `$HOME` paths with your actual home directory or use `%USERPROFILE%`.

---

## Control Script (`local/camofox-ctl`)

Usage: `local/camofox-ctl {start|stop|restart|status|ensure|logs|url|open}`

### Windows PowerShell wrapper

See `local/camofox-ctl.ps1` for a PowerShell equivalent. Usage:

```powershell
& .\local\camofox-ctl.ps1 start
& .\local\camofox-ctl.ps1 status
& .\local\camofox-ctl.ps1 stop
```

---

## Cookie Migration

Import cookies from the old camoufox-mcp Firefox profile:

```powershell
node local/import-old-cookies.mjs
```

Uses `better-sqlite3` (bundled with camofox-browser deps).

---

## Self-Check (`local/selfcheck.mjs`)

Verifies the full stack:
1. camofox-browser REST server is reachable and healthy
2. MCP server can list tools and execute a call
3. Reports mode (headless vs headed), user ID, version

Run from the camofox-browser repo root:
```bash
node local/selfcheck.mjs
```

---

## Files in This Patchset

| File | Purpose | Windows? |
|------|---------|----------|
| `local/camofox.env` | Central env config (sourced by ctl/selfcheck) | ✅ (edit paths) |
| `local/camofox-ctl` | Bash control script | ❌ use `.ps1` |
| `local/camofox-ctl.ps1` | PowerShell control script | ✅ |
| `local/selfcheck.mjs` | End-to-end selfcheck | ✅ |
| `local/import-old-cookies.mjs` | Cookie migration utility | ✅ |

## Files NOT pushed (Linux-specific)

- `local/openrc/camofox-browser` — OpenRC unit (Gentoo only)
- `local/autostart/camofox-browser.desktop` — Linux desktop autostart
- `local/test-openrc-env.sh` — OpenRC env acceptance test

---

## Licensing

- **Upstream code** (`camofox-browser` repo): MIT License (Jo, Inc)
- **This patchset** (files in `local/` here): MIT License

This patchset adds to the upstream repository; it does not modify or redistribute upstream code. The original MIT license of `jo-inc/camofox-browser` applies to the upstream codebase.

---

## Troubleshooting

### "camofox error: connect ECONNREFUSED"
The REST server isn't running. Start it: `.\build.ps1 up` (Windows) or ensure the server process is running.

### MCP tools not showing
The MCP server may have started before the REST server was ready. Restart the MCP proxy.

### Cookie import fails with `better-sqlite3` errors
Make sure you're in the camofox-browser repo root (the `mcp/` deps are resolved from the repo root's `node_modules`).

### Port conflict
Check what's listening: `netstat -ano | findstr :9377` (Windows) or `ss -tlnp | grep 9377` (Linux).
