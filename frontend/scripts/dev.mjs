// `npm run dev` for the dashboard: http://localhost:3000 (set PORT to use another port).
// Same as `next dev`, plus: it refuses to start a second copy, and it tells you if the backend is not running yet.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 3000);
const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';

const portOpen = (p, host = '127.0.0.1') => new Promise((done) => {
  const socket = net.connect({ port: p, host });
  const end = (open) => { socket.destroy(); done(open); };
  socket.setTimeout(800);
  socket.once('connect', () => end(true));
  socket.once('timeout', () => end(false));
  socket.once('error', () => end(false));
});

if (await portOpen(port)) {
  console.error(`\nSomething is already running on port ${port}. If it is the DEODScan dashboard, just open http://localhost:${port}.\nTo start a new one, stop the old one first: Ctrl+C in its terminal, or run stop.cmd from the project folder.\n`);
  process.exit(1);
}

try {
  const res = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.warn(`\nNote: the backend API is not answering at ${apiBase}.\nStart it in the other terminal: cd ..\\backend, then npm run dev. Pages show an error until it is up.\n`);
}

const nextBin = resolve(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], { cwd: root, stdio: 'inherit', env: process.env });

// Ctrl+C reaches both this script and Next at once, and Next shuts itself down. If this script is asked to stop another
// way (SIGTERM, Ctrl+Break), give Next a few seconds to exit, then end it and everything it started.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      if (child.exitCode === null) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      }
    }, 8000).unref();
  });
}
child.on('exit', (code) => process.exit(code ?? 0));
