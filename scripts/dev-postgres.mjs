// Local development Postgres (no Docker/admin needed). Data lives in ./.pgdata (git-ignored).
// Production should use docker-compose.yml or a managed Postgres via DATABASE_URL.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const port = Number(process.env.DEV_PG_PORT ?? 5433);
const pg = new EmbeddedPostgres({ databaseDir: './.pgdata', user: 'deod', password: 'deod', port, persistent: true });

if (!existsSync('./.pgdata/PG_VERSION')) await pg.initialise();
await pg.start();
try { await pg.createDatabase('deod_monitor'); } catch { /* already exists */ }
console.log(`Postgres running: postgres://deod:deod@localhost:${port}/deod_monitor  (Ctrl+C to stop)`);

const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
