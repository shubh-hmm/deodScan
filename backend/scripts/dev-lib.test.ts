import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, dbTarget, isPortOpen, parseArgs, prettyLine, releaseLock, stopInOrder, waitFor } from './dev-lib.js';

describe('parseArgs: the worker is opt-in, so nothing can spend Dune credits by accident', () => {
  it('is off by default', () => expect(parseArgs([], {}).worker).toBe(false));
  it('turns on with --worker', () => expect(parseArgs(['--worker'], {}).worker).toBe(true));
  it('turns on with DEV_WORKER=1', () => expect(parseArgs([], { DEV_WORKER: '1' }).worker).toBe(true));
  it('turns on with npm_config_worker=true (what npm sets when PowerShell swallows the --)', () => expect(parseArgs([], { npm_config_worker: 'true' }).worker).toBe(true));
  it('--no-worker beats DEV_WORKER=1', () => expect(parseArgs(['--no-worker'], { DEV_WORKER: '1' }).worker).toBe(false));
  it('ignores other values of DEV_WORKER', () => expect(parseArgs([], { DEV_WORKER: '0' }).worker).toBe(false));
  it('knows --help', () => expect(parseArgs(['--help'], {}).help).toBe(true));
});

describe('isPortOpen / waitFor', () => {
  it('sees an open port and then a closed one', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await isPortOpen(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await isPortOpen(port)).toBe(false);
  });
  it('waitFor returns true once the condition holds', async () => {
    const start = Date.now();
    expect(await waitFor(() => Date.now() - start > 150, 3000, 50)).toBe(true);
  });
  it('waitFor returns false on timeout, and survives a check that throws', async () => {
    expect(await waitFor(() => { throw new Error('nope'); }, 200, 50)).toBe(false);
  });
});

describe('lock file: one supervisor per backend folder', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deodscan-lock-')); file = join(dir, 'dev.lock'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is taken when free, and holds our PID', () => {
    expect(acquireLock(file).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
  });
  it('refuses while the PID in it is still running', () => {
    writeFileSync(file, String(process.pid));
    const second = acquireLock(file, 4_000_000);
    expect(second).toEqual({ ok: false, pid: process.pid });
  });
  it('replaces a stale lock whose process is gone', () => {
    writeFileSync(file, '2000000000');
    expect(acquireLock(file).ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
  });
  it('replaces a corrupt lock', () => {
    writeFileSync(file, 'not a pid');
    expect(acquireLock(file).ok).toBe(true);
  });
  it('is released only by its owner', () => {
    acquireLock(file);
    releaseLock(file, 4_000_000);
    expect(existsSync(file)).toBe(true);
    releaseLock(file);
    expect(existsSync(file)).toBe(false);
  });
});

describe('dbTarget', () => {
  it('reads a local URL', () => {
    expect(dbTarget('mongodb://localhost:27018/deod_monitor')).toEqual({ host: 'localhost', port: 27018, database: 'deod_monitor', local: true });
  });
  it('ignores credentials and options', () => {
    expect(dbTarget('mongodb://deod:p%40ss@127.0.0.1:27018/deod_monitor?authSource=admin')).toEqual({ host: '127.0.0.1', port: 27018, database: 'deod_monitor', local: true });
  });
  it('marks a remote host as not local', () => expect(dbTarget('mongodb://u:p@db.example.com:27017/x').local).toBe(false));
  it('marks an Atlas address as not local', () => expect(dbTarget('mongodb+srv://u:p@cluster0.abcde.mongodb.net/x').local).toBe(false));
  it('uses the first host of a replica set list', () => expect(dbTarget('mongodb://a.example.com:27017,b.example.com:27017/x?replicaSet=rs')).toMatchObject({ host: 'a.example.com', port: 27017 }));
  it('defaults the port to 27017 and the database to deod_monitor', () => expect(dbTarget('mongodb://127.0.0.1')).toMatchObject({ port: 27017, database: 'deod_monitor' }));
  it('reads an IPv6 address', () => expect(dbTarget('mongodb://[::1]:27018/x')).toMatchObject({ host: '[::1]', port: 27018, local: true }));
  it('rejects a PostgreSQL URL with a clear message', () => expect(() => dbTarget('postgres://u:p@localhost:5433/x')).toThrow(/MONGODB_URI/));
});

describe('prettyLine', () => {
  it('shortens a pino line', () => {
    const line = JSON.stringify({ level: 30, time: new Date(2026, 9, 12, 14, 5, 9).getTime(), svc: 'worker', msg: 'dune window done', fetched: 14, credits: 0.07 });
    expect(prettyLine(line)).toBe('14:05:09 INFO  dune window done  fetched=14 credits=0.07');
  });
  it('labels errors', () => expect(prettyLine('{"level":50,"time":0,"msg":"boom"}')).toContain('ERROR boom'));
  it('leaves other output alone', () => {
    expect(prettyLine('plain text')).toBe('plain text');
    expect(prettyLine('{"level":broken')).toBe('{"level":broken');
  });
});

describe('stopInOrder', () => {
  it('stops in the given order and a failure does not block the rest', async () => {
    const order: string[] = [];
    const messages: string[] = [];
    const failed = await stopInOrder([
      { name: 'worker', stop: async () => { order.push('worker'); } },
      { name: 'api', stop: async () => { order.push('api'); throw new Error('stuck'); } },
      { name: 'database', stop: async () => { order.push('database'); } },
    ], (m) => messages.push(m));
    expect(order).toEqual(['worker', 'api', 'database']);
    expect(failed).toEqual(['api']);
    expect(messages.some((m) => m.includes('api did not stop cleanly: stuck'))).toBe(true);
  });
});
