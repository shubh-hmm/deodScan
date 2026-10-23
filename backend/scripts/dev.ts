// One command for the whole backend:
//
//   npm run dev                  MongoDB + API                 (no Dune credits can be spent)
//   npm run dev:worker           MongoDB + API + Dune sync worker      (also: npm run dev -- --worker, or DEV_WORKER=1)
//
// - Reuses anything that is already running (a database or API started another way) and never stops what it did not start.
// - Refuses to run twice in the same folder (lock file) and never starts a second worker.
// - Ctrl+C stops things in reverse order: worker (lets a running sync finish), API, then the database cleanly.
//
// Settings come from backend/.env as before (MONGODB_URI, API_PORT ...). Testing hooks: DEV_MONGO_DATA (database folder),
// DEV_LOCK_FILE (lock file), DEV_DB_VERBOSE=1 (show every MongoDB log line), MONGOD_PATH (use this mongod program).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';
import { MongoClient } from 'mongodb';
import { backendRoot, loadEnv } from '@deod/config';
import { acquireLock, dbTarget, isPortOpen, parseArgs, prettyLine, releaseLock, stopInOrder, waitFor, type Stoppable } from './dev-lib.js';

const opts = parseArgs(process.argv.slice(2), process.env);
if (opts.help) {
  console.log(`DEODScan backend, one command.

  npm run dev                 start MongoDB and the API
  npm run dev:worker          also start the Dune sync worker (uses Dune credits)

Press Ctrl+C once to stop everything cleanly.`);
  process.exit(0);
}

// ---------------------------------------------------------------- output
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const TAGS = { dev: '90', db: '35', api: '36', worker: '33' } as const;
type Tag = keyof typeof TAGS;
function say(tag: Tag, text: string) {
  const label = `[${tag}]`.padEnd(9);
  console.log(`${useColor ? `\x1b[${TAGS[tag]}m${label}\x1b[0m` : label} ${text}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- setup
const root = backendRoot();
const lockFile = process.env.DEV_LOCK_FILE ?? resolve(root, '.dev.lock');
const lock = acquireLock(lockFile);
if (!lock.ok) {
  console.error(`\nThe backend is already running from this folder (process ${lock.pid}).\nStop that one first: press Ctrl+C in its terminal, or run .\\stop.cmd from the project folder.\n`);
  process.exit(1);
}

const env = loadEnv();
const db = dbTarget(env.MONGODB_URI);
const apiHost = process.env.API_HOST ?? '127.0.0.1';
const apiPort = env.API_PORT;

/** Everything this command started, in start order. Shutdown walks it backwards. */
const owned: Stoppable[] = [];
const childPids = new Set<number>();
let shuttingDown = false;
let finish!: (code: number) => void;
const finished = new Promise<number>((r) => { finish = r; });

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

async function shutdown(reason: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  say('dev', `${reason}. Stopping (worker, API, database)...`);
  const failed = await stopInOrder([...owned].reverse(), (m) => say('dev', m));
  releaseLock(lockFile);
  say('dev', failed.length ? 'Stopped, with problems (see above).' : 'Everything stopped cleanly.');
  finish(failed.length ? 1 : code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(sig, () => {
    if (shuttingDown) {
      // A second Ctrl+C means "now": kill what is left and leave.
      say('dev', 'Second signal: forcing exit.');
      for (const pid of childPids) killTree(pid);
      releaseLock(lockFile);
      process.exit(1);
    }
    void shutdown(`Received ${sig}`);
  });
}
process.on('uncaughtException', (e) => { say('dev', `Unexpected error: ${e.message}`); void shutdown('Unexpected error', 1); });
process.on('unhandledRejection', (e) => { say('dev', `Unexpected error: ${String(e)}`); void shutdown('Unexpected error', 1); });

// ---------------------------------------------------------------- 1. database
// MongoDB is started as its own detached process, outside the terminal's Ctrl+C group. A terminal sends Ctrl+C to every process in it,
// which would pull the database out from under the API and the worker (and a sync in progress) before they have finished. Detached, it only
// stops when this command stops it, last, by asking the server to shut down.

function showDbLog(logFile: string, fromByte: number) {
  // mongod writes one JSON object per line; "s" is the severity (I info, W warning, E error, F fatal). Only W/E/F are shown unless DEV_DB_VERBOSE=1.
  const verbose = process.env.DEV_DB_VERBOSE === '1';
  try {
    const text = readFileSync(logFile, 'utf8').slice(fromByte);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { s?: string; msg?: string; attr?: { error?: string } };
        if (verbose || j.s === 'W' || j.s === 'E' || j.s === 'F') say('db', `${j.s ?? ''} ${j.msg ?? ''}${j.attr?.error ? ` (${j.attr.error})` : ''}`.trim());
      } catch { if (verbose) say('db', line); }
    }
  } catch { /* no log yet */ }
}

/** The mongod program: MONGOD_PATH, one on the PATH, or the copy mongodb-memory-server keeps in its cache (downloaded once, then reused). */
async function findMongod(): Promise<string> {
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  if (spawnSync('mongod', ['--version'], { stdio: 'ignore' }).status === 0) return 'mongod';
  const { MongoBinary } = await import('mongodb-memory-server-core');
  return MongoBinary.getPath();
}

async function pingDb(): Promise<boolean> {
  const c = new MongoClient(`mongodb://127.0.0.1:${db.port}`, { serverSelectionTimeoutMS: 1500, directConnection: true });
  try { await c.db('admin').command({ ping: 1 }); return true; } catch { return false; } finally { await c.close().catch(() => {}); }
}

async function startDatabase() {
  if (await isPortOpen(db.port, '127.0.0.1')) {
    say('db', `already running on port ${db.port}; reusing it (this command will not stop it)`);
    return;
  }
  if (!db.local) throw new Error(`The database at ${db.host}:${db.port} (from MONGODB_URI) is not reachable, and it is not on this computer, so it cannot be started here.`);

  const mongod = await findMongod();
  const dataDir = process.env.DEV_MONGO_DATA ?? resolve(root, '.mongodata');
  const logFile = resolve(dataDir, 'mongod.log');
  if (!existsSync(dataDir)) { say('db', `no database found; creating a new empty one in ${dataDir}`); mkdirSync(dataDir, { recursive: true }); }

  say('db', `starting MongoDB on port ${db.port} (after a PC restart this can take a little while)...`);
  const offset = existsSync(logFile) ? statSync(logFile).size : 0;
  const server = spawn(mongod, ['--dbpath', dataDir, '--port', String(db.port), '--bind_ip', '127.0.0.1', '--logpath', logFile, '--logappend'], { detached: true, stdio: 'ignore', windowsHide: true });
  server.unref();
  let earlyExit: number | null | undefined;
  server.once('exit', (code) => { earlyExit = code; });

  const up = await waitFor(async () => {
    if (earlyExit !== undefined) throw new Error('mongod exited');
    return (await isPortOpen(db.port, '127.0.0.1')) && (await pingDb());
  }, 180_000, 700).catch(() => false);
  if (!up) {
    showDbLog(logFile, offset);
    throw new Error(`MongoDB did not start (see ${logFile}).`);
  }
  owned.push({
    name: 'database',
    stop: async () => {
      const before = existsSync(logFile) ? statSync(logFile).size : 0;
      const c = new MongoClient(`mongodb://127.0.0.1:${db.port}`, { serverSelectionTimeoutMS: 5000, directConnection: true });
      // A server that accepts "shutdown" closes the connection instead of answering, so an error here is the normal outcome.
      try { await c.db('admin').command({ shutdown: 1, timeoutSecs: 30 }); } catch { /* connection closed by the shutting-down server */ } finally { await c.close().catch(() => {}); }
      if (!(await waitFor(async () => !(await isPortOpen(db.port, '127.0.0.1')), 60_000, 300))) throw new Error('MongoDB did not stop within 60 seconds');
      showDbLog(logFile, before);
    },
  });
  showDbLog(logFile, offset);
  say('db', `ready on port ${db.port}`);
}

// ---------------------------------------------------------------- children (API, worker)
function startChild(tag: 'api' | 'worker', entry: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  if (child.pid) childPids.add(child.pid);
  for (const stream of [child.stdout!, child.stderr!]) {
    readline.createInterface({ input: stream }).on('line', (l) => { if (l.trim()) say(tag, prettyLine(l)); });
  }
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.once('exit', (code) => {
    if (child.pid) childPids.delete(child.pid);
    if (shuttingDown) return;
    say(tag, `exited unexpectedly (code ${code})`);
    if (tag === 'api') void shutdown('The API stopped', 1);
  });
  return { child, exited };
}

/** Asks the child to shut down by message (works on Windows, unlike signals), then force-kills it if it takes too long. */
async function stopChild(child: ChildProcess, exited: Promise<void>, graceMs: number) {
  if (child.exitCode !== null || child.signalCode) return;
  try { child.send?.('shutdown'); } catch { /* channel already closed */ }
  const clean = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!clean) {
    say('dev', `a process did not stop within ${Math.round(graceMs / 1000)} s; forcing it`);
    killTree(child.pid);
    await exited;
  }
}

// ---------------------------------------------------------------- 2. API
async function startApi() {
  const healthUrl = `http://${apiHost}:${apiPort}/api/health`;
  const healthy = async () => { try { return (await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
  if (await isPortOpen(apiPort, apiHost)) {
    if (await healthy()) { say('api', `already running on port ${apiPort}; reusing it (this command will not stop it)`); return; }
    throw new Error(`Port ${apiPort} is already in use by something that is not the DEODScan API. Free the port or change API_PORT in backend/.env.`);
  }
  say('api', `starting on http://${apiHost}:${apiPort}`);
  const { child, exited } = startChild('api', 'api/src/server.ts');
  owned.push({ name: 'api', stop: () => stopChild(child, exited, 15_000) });
  if (!(await waitFor(healthy, 60_000))) throw new Error('The API did not answer within 60 seconds. Look at the [api] lines above.');
  say('api', 'ready');
}

// ---------------------------------------------------------------- 3. worker (optional)
function findRunningWorkers(): number[] {
  if (process.platform !== 'win32') return [];
  const command = String.raw`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'worker[\\/]src[\\/]index' } | Select-Object -ExpandProperty ProcessId`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  return String(r.stdout ?? '').split(/\r?\n/).map(Number).filter((n) => n > 0 && n !== process.pid);
}

let workerRunningElsewhere = false;

function startWorker() {
  const existing = findRunningWorkers();
  workerRunningElsewhere = existing.length > 0;
  if (!opts.worker) {
    if (existing.length) { say('worker', `already running (started another way, process ${existing.join(', ')}); this command will not stop it`); return; }
    say('worker', 'OFF, so no Dune credits will be used. To start it too: npm run dev:worker');
    return;
  }
  if (existing.length) {
    say('worker', `a worker is already running (process ${existing.join(', ')}); not starting a second one`);
    return;
  }
  const { child, exited } = startChild('worker', 'worker/src/index.ts');
  owned.push({ name: 'worker', stop: () => stopChild(child, exited, 40_000) });
  say('worker', 'started. It fetches any finished days it missed (this uses Dune credits), then checks once an hour');
}

// ---------------------------------------------------------------- run
try {
  await startDatabase();
  if (shuttingDown) await finished;
  else {
    await startApi();
    if (!shuttingDown) startWorker();
    if (!shuttingDown && owned.length === 0) {
      // Everything was already running (for example started by .\\run.cmd): there is nothing for this terminal to watch or stop, so say so and
      // exit cleanly instead of leaving the process to fall out of its event loop with a confusing Node warning.
      console.log(`
  DEODScan backend was ALREADY RUNNING (started earlier, for example by .\\run.cmd), so nothing new was started here.
    Database  ${db.host}:${db.port}/${db.database}
    API       http://${apiHost}:${apiPort}
    Worker    ${workerRunningElsewhere ? 'on (already running)' : 'off'}
  It keeps running in the background. To stop it: run .\\stop.cmd in the project folder.
  To run it in this terminal instead: run .\\stop.cmd first, then npm run dev (or npm run dev:worker) again.
`);
      releaseLock(lockFile);
      process.exit(0);
    }
    if (!shuttingDown) {
      console.log(`
  DEODScan backend is running
    Database  ${db.host}:${db.port}/${db.database}
    API       http://${apiHost}:${apiPort}
    Worker    ${opts.worker || workerRunningElsewhere ? 'on' : 'off (npm run dev:worker to turn it on)'}
  Dashboard: in a second terminal, cd ..\\frontend then npm run dev  (http://localhost:3000)
  Stop everything with Ctrl+C.
`);
    }
  }
} catch (e) {
  say('dev', `Could not start: ${(e as Error).message}`);
  await shutdown('Startup failed', 1);
}
process.exit(await finished);
