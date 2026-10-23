// `npm run db:migrate`: create / update the collections, indexes and validators, then upsert config-defined exchanges/addresses/pools.
import { closeDb, getDb, migrate, seedFromConfig } from './index.js';

const db = getDb();
const done = await migrate(db);
await seedFromConfig(db);
console.log(done.length ? `applied: ${done.join(', ')}` : 'no pending migrations', '| config seeded');
await closeDb();
