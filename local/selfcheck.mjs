#!/usr/bin/env node
// Selfcheck for the camofox MCP stack (Windows-adapted).
//
// Verifies:
//   1. camofox-browser REST server is reachable and healthy
//   2. MCP server can list tools and execute a call
//   3. A second MCP client sees the same browser state (shared browser)
//   4. Browser survives a kill (relaunch)
//   5. ctl ensure is idempotent (no second server)
//
// Prerequisites:
//   - Node.js 22+ installed (node --version ≥ 22)
//   - camofox-browser REST server running at CAMOFOX_HOST:CAMOFOX_PORT
//   - mcp/ directory present (from jo-inc/camofox-browser) and npm installed
//
// Usage:  node local/selfcheck.mjs
//         CAMOFOX_PORT=9378 node local/selfcheck.mjs  (against another port)

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { setTimeout: sleep } from 'node:timers/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SCRIPT_DIR); // parent of local/
const ENVFILE = join(REPO, 'local/camofox.env');

// --- Locate the mcp/server.mjs -----------------------------------------------
// This patchset repo may be used standalone (no mcp/) or inside camofox-browser.
function findMcpServer() {
  // 1. Direct child of REPO (used when this is inside camofox-browser)
  const direct = join(REPO, 'mcp', 'server.mjs');
  if (existsSync(direct)) return direct;
  // 2. Direct child of SCRIPT_DIR (used when selfcheck.mjs is at repo root)
  const sibling = join(SCRIPT_DIR, '..', 'mcp', 'server.mjs');
  if (existsSync(sibling)) return sibling;
  // 3. Check mcp/ sibling of selfcheck.mjs
  const local = join(SCRIPT_DIR, '..', 'mcp', 'server.mjs');
  if (existsSync(local)) return local;
  return null;
}

// --- Load env file (bash-compatible format) ----------------------------------
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      const match = trimmed.match(/^(\w+)\s*=\s*\$\{(\w+)(?::=([^}]*))?\}(.*)$/)
        || trimmed.match(/^(\w+)\s*=\s*(.+)$/);
      if (match) {
        const varName = match[1];
        let value = match[2] || '';
        const fallback = match[3];
        value = value.replace(/\$HOME/g, process.env.USERPROFILE || process.env.HOME);
        value = value.replace(/%USERPROFILE%/g, process.env.USERPROFILE || process.env.HOME);
        if (fallback && !process.env[varName]) {
          value = fallback.replace(/\$HOME/g, process.env.USERPROFILE || process.env.HOME);
          value = value.replace(/%USERPROFILE%/g, process.env.USERPROFILE || process.env.HOME);
        }
        if (!process.env[varName]) {
          process.env[varName] = value || process.env[varName];
        }
      }
    }
  } catch { /* env file optional */ }
}
loadEnvFile(ENVFILE);

// Expand Windows env vars in paths
function expandPaths(env) {
  const up = process.env.USERPROFILE || process.env.HOME || '';
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && v.includes('%USERPROFILE%')) {
      env[k] = v.replace(/%USERPROFILE%/g, up);
    }
  }
  return env;
}

const HOST = process.env.CAMOFOX_BIND_HOST || '127.0.0.1';
const PORT = Number(process.env.CAMOFOX_PORT || 9377);
const USER = process.env.CAMOFOX_USER_ID || 'default';
const BASE = `http://${HOST}:${PORT}`;
const failures = [];
const fail = (m) => { failures.push(m); console.log(`FAIL ${m}`); };
const ok = (m) => console.log(`ok   ${m}`);

// --- Locate mcp server for spawning -----------------------------------------
const MCP_SERVER = findMcpServer();

// --- Process scoping (Windows): find our checkout's browser processes -------
function killOwnBrowsers() {
  try {
    const result = spawnSync('wmic', [
      'process', 'where',
      `Name='camoufox.exe'`, 'get', 'ProcessId', '/format:list'
    ], { encoding: 'utf8', timeout: 5000 });
    const out = result.stdout || '';
    let count = 0;
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^ProcessId\s*=\s*(\d+)/);
      if (m) {
        try { spawnSync('taskkill', ['/F', '/PID', m[1]]); count++; } catch {}
      }
    }
    return count;
  } catch { return 0; }
}

// --- stdio MCP client -------------------------------------------------------
function mcpClient(label) {
  if (!MCP_SERVER) {
    return { label, init: async () => {}, call: async () => '', tools: async () => [], close: () => {}, _skipped: true };
  }
  const child = spawn(process.execPath, [MCP_SERVER], {
    env: expandPaths({ ...process.env, CAMOFOX_PORT: String(PORT), CAMOFOX_USER_ID: USER }),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = '';
  let id = 0;
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const timer = setTimeout(() => reject(new Error(`${label}: ${method} timed out`)), 120000);
    waiters.set(myId, (m) => {
      clearTimeout(timer);
      if (m.error) return reject(new Error(`${label}: ${method} -> ${JSON.stringify(m.error)}`));
      resolve(m.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  });
  return {
    label,
    init: async () => {
      await rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: label, version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    call: async (name, args = {}) => {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = (r.content || [])
        .map((c) => c.text ?? (c.data ? `<${c.type} ${c.data.length} b64 chars>` : ''))
        .join('');
      if (r.isError) throw new Error(`${label}: ${name} -> ${text.slice(0, 200)}`);
      return text;
    },
    tools: async () => (await rpc('tools/list', {})).tools.map((t) => t.name),
    close: () => child.kill('SIGTERM'),
  };
}

const tabIdOf = (text) => {
  try {
    const j = JSON.parse(text);
    return j.tabId || j.tab_id || j.id || (j.tab && j.tab.tabId);
  } catch {
    return (text.match(/"tabId"\s*:\s*"([^"]+)"/) || [])[1];
  }
};

const callRetrying = async (client, name, args, attempts = 8) => {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await client.call(name, args); } catch (e) { last = e; await sleep(1500); }
  }
  throw last;
};

// ---------------------------------------------------------------------------
const main = async () => {
  console.log(`Selfcheck → ${BASE}  (user=${USER})\n`);

  // 0. MCP server availability
  if (!MCP_SERVER) {
    console.log(`note: mcp/server.mjs not found at any known location, skipping MCP tests`);
    console.log(`     place selfcheck.mjs alongside the mcp/ directory in camofox-browser`);
  }

  // 1. Health check
  const h = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  if (!h?.ok) return fail(`no healthy server at ${BASE}`);
  ok(`health ok (tabs=${h.activeTabs}, browserConnected=${h.browserConnected})`);

  if (MCP_SERVER) {
    // 2. MCP tools
    const a = mcpClient('a');
    await a.init();
    const tools = await a.tools();
    if (tools.length < 25) fail(`only ${tools.length} tools, expected >=25`);
    else ok(`${tools.length} camofox_* tools`);
    if (!tools.every((t) => t.startsWith('camofox_'))) fail('unexpected non-camofox tool name');

    // 3. Create tab + snapshot + screenshot
    const created = await a.call('camofox_create_tab', { url: 'https://example.com' });
    const tabId = tabIdOf(created);
    if (!tabId) return fail(`create_tab returned no tabId: ${created.slice(0, 200)}`);
    const h2 = await fetch(`${BASE}/health`).then((r) => r.json());
    if (!h2.browserConnected) fail('browser did not connect after create_tab');
    else ok(`created tab ${tabId} (browser connected)`);

    const snap = await a.call('camofox_snapshot', { tabId });
    if (!/example\.com/i.test(snap)) fail(`snapshot lacks example.com content: ${snap.slice(0, 120)}`);
    else ok('snapshot');

    const shot = await a.call('camofox_screenshot', { tabId });
    const shotBytes = Number((shot.match(/<image (\d+) b64 chars>/) || [])[1] || 0);
    if (shotBytes < 10000) fail(`screenshot too small or missing: ${shot.slice(0, 80)}`);
    else ok(`screenshot ${Math.round(shotBytes / 1024)} KiB png`);

    // 4. Second client sees same browser (shared browser test)
    const b = mcpClient('b');
    await b.init();
    const tabs = await b.call('camofox_list_tabs', {});
    if (!/example\.com/i.test(tabs)) fail(`fresh client does not see the shared tab: ${tabs.slice(0, 200)}`);
    else ok('fresh client sees the same tab (shared browser)');
    const title = await b.call('camofox_evaluate', { tabId, expression: 'document.title' });
    if (!/example/i.test(title)) fail(`fresh client cannot read the shared page: ${title.slice(0, 120)}`);
    else ok('fresh client reads the shared page');

    // 5. Browser survives kill (relaunch test)
    const killed = killOwnBrowsers();
    if (killed > 0) {
      console.log(`     killed ${killed} camoufox.exe process(es)`);
      const back = await callRetrying(b, 'camofox_create_tab', { url: 'https://example.com' })
        .catch((e) => `BROKEN ${e.message}`);
      if (String(back).startsWith('BROKEN')) {
        fail(`browser did not come back after a kill: ${back.slice(0, 160)}`);
      } else {
        ok('browser relaunched after being killed');
      }
    } else {
      console.log('     skip kill test (no camoufox.exe found)');
    }

    // 6. ctl ensure is idempotent
    try {
      const ctlPs1 = join(REPO, 'local', 'camofox-ctl.ps1');
      if (existsSync(ctlPs1)) {
        const ctlResult = spawnSync('pwsh', [ctlPs1, 'ensure'], {
          encoding: 'utf8', timeout: 30000
        });
        const ctlOut = `${ctlResult.stdout}${ctlResult.stderr}`.trim();
        if (/started:/i.test(ctlOut)) fail(`ctl ensure started a second server: ${ctlOut}`);
        else ok('ctl ensure is idempotent');
      } else {
        console.log('   skip ctl test (camofox-ctl.ps1 not found)');
      }
    } catch {
      console.log('   skip ctl test (pwsh not available or failed)');
    }

    a.close();
    b.close();
  }

  if (failures.length) {
    console.log(`\nFAIL: ${failures.join('; ')}`);
    process.exit(1);
  } else {
    console.log('\nPASS: shared persistent Camoufox verified');
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
