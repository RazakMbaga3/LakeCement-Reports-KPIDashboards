/*
  scripts/smoke.js — Phase 0 smoke test.

  Boots server.js on a scratch port (so it never collides with a running
  dev server), polls /api/health until it answers 200 or 15s elapse,
  then kills the child and exits 0 (green) or 1 (red).

  Usage: npm run smoke        (from backend/)
         SMOKE_PORT=5902 npm run smoke   to override the port
*/

const { spawn } = require('child_process');
const path      = require('path');

const PORT = process.env.SMOKE_PORT || 5901;

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env:   { ...process.env, PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
child.stdout.on('data', d => { serverOutput += d; });
child.stderr.on('data', d => { serverOutput += d; });

function finish(code, message) {
  console[code === 0 ? 'log' : 'error'](message);
  if (code !== 0) console.error('--- server output ---\n' + serverOutput);
  child.kill();
  process.exit(code);
}

async function poll() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) {
        const body = await res.json();
        return finish(0, `SMOKE OK — /api/health ${res.status}: ${JSON.stringify(body)}`);
      }
      return finish(1, `SMOKE FAIL — /api/health returned HTTP ${res.status}`);
    } catch {
      await new Promise(r => setTimeout(r, 400)); // server not up yet
    }
  }
  finish(1, 'SMOKE FAIL — /api/health not reachable within 15s');
}

child.on('exit', (code) => {
  // Server died before we got a healthy response (e.g. port in use, syntax error)
  if (code !== null && code !== 0) finish(1, `SMOKE FAIL — server exited early (code ${code})`);
});

poll();
