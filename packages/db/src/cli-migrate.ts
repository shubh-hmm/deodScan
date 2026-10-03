// `npm run db:migrate`: apply pending migrations, then upsert config-defined exchanges/addresses/pools.
import { closePool, getPool, migrate, seedFromConfig } from './index.js';

const pool = getPool();
const done = await migrate(pool);
await seedFromConfig(pool);
console.log(done.length ? `applied: ${done.join(', ')}` : 'no pending migrations', '| config seeded');
await closePool();
