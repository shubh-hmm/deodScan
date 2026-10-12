// Local development Postgres (no Docker/admin needed). Data lives in backend/.pgdata (git-ignored).
// Production should use docker-compose.yml or a managed Postgres via DATABASE_URL.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The data folder lives in backend/.pgdata no matter where this is started from.
const DATA = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.pgdata');

const port = Number(process.env.DEV_PG_PORT ?? 5433);
const pg = new EmbeddedPostgres({ databaseDir: DATA, user: 'deod', password: 'deod', port, persistent: true });

if (!existsSync(resolve(DATA, 'PG_VERSION'))) await pg.initialise();
await pg.start();
try { await pg.createDatabase('deod_monitor'); } catch { /* already exists */ }
console.log(`Postgres running: postgres://deod:deod@localhost:${port}/deod_monitor  (Ctrl+C to stop)`);

const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
