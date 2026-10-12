// Helpers for scripts/dev.ts (the one-command backend). Pure and small, so they can be unit-tested.
import net from 'node:net';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface DevOptions {
  /** Also start the Dune sync worker. Off by default because a sync can spend Dune credits. */
  worker: boolean;
  help: boolean;
}

/** `npm run dev` -> worker off. `npm run dev:worker`, `npm run dev -- --worker` or DEV_WORKER=1 -> worker on. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): DevOptions {
  const has = (flag: string) => argv.includes(flag);
  // npm turns `npm run dev --worker` into npm_config_worker=true. That is what arrives when PowerShell swallows the `--` in
  // `npm run dev -- --worker`, so it counts too.
  const on = (v: unknown) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
  const envOn = on(env.DEV_WORKER) || on(env.npm_config_worker);
  return { worker: (has('--worker') || envOn) && !has('--no-worker'), help: has('--help') || has('-h') };
}

/** True when something accepts TCP connections on host:port. */
export function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Polls `check` until it returns true or the time runs out. */
export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, intervalMs = 400): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await check()) return true; } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * One supervisor per backend folder. The lock file holds the supervisor's PID. A lock left behind by a crashed
 * supervisor (its PID is no longer running) is replaced.
 */
export function acquireLock(file: string, pid = process.pid): { ok: true } | { ok: false; pid: number } {
  if (existsSync(file)) {
    const other = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(other) && other > 0 && other !== pid && pidAlive(other)) return { ok: false, pid: other };
  }
  writeFileSync(file, String(pid));
  return { ok: true };
}

export function releaseLock(file: string, pid = process.pid): void {
  try {
    if (existsSync(file) && Number(readFileSync(file, 'utf8').trim()) === pid) unlinkSync(file);
  } catch { /* best effort */ }
}

/** Where DATABASE_URL points, and whether this machine should run that database itself. */
export function dbTarget(databaseUrl: string) {
  const u = new URL(databaseUrl);
  const host = u.hostname;
  return {
    host,
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    local: ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host),
  };
}

const LEVELS: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO ', 40: 'WARN ', 50: 'ERROR', 60: 'FATAL' };
const HIDDEN = new Set(['level', 'time', 'pid', 'hostname', 'svc', 'msg']);

/** Turns a pino JSON log line into a short readable one; any other line is returned unchanged. */
export function prettyLine(line: string): string {
  if (!line.startsWith('{"level"')) return line;
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    if (typeof j.level !== 'number') return line;
    const time = typeof j.time === 'number' ? new Date(j.time).toTimeString().slice(0, 8) : '';
    const extras = Object.entries(j)
      .filter(([k]) => !HIDDEN.has(k))
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const out = `${time} ${LEVELS[j.level] ?? j.level} ${String(j.msg ?? '')}${extras ? '  ' + extras : ''}`.trim();
    return out.length > 240 ? out.slice(0, 237) + '...' : out;
  } catch { return line; }
}

export interface Stoppable { name: string; stop: () => Promise<void> }

/** Stops things one after another (callers pass them in the order they should stop). A failure never blocks the rest. */
export async function stopInOrder(items: Stoppable[], log: (message: string) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const item of items) {
    try { await item.stop(); log(`${item.name} stopped`); } catch (e) { failed.push(item.name); log(`${item.name} did not stop cleanly: ${(e as Error).message}`); }
  }
  return failed;
}
