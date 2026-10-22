// Alert list, alert rules and the wallet watchlist. Everything is read from (or, for the watchlist, written to) the application database;
// nothing here calls Dune or any other service.
import type pg from 'pg';
import { z } from 'zod';

/** Shown next to every watchlist control and alert list: what monitoring can and cannot see. */
export const WATCH_LIMITATION =
  'Monitoring covers only transactions that are recorded in this database: transfers to and from the monitored exchange addresses and swaps ' +
  'on the monitored PancakeSwap pools. It does not see other transfers of a wallet, and it can lag by up to a day because data is synced ' +
  'once per finished UTC day (or when you press Update today). Absence of an alert does not mean a wallet did nothing.';

export const MAX_WATCHED = 200;

export const AlertFilter = z.object({
  rule: z.string().regex(/^[a-z_]+$/).optional(),
  exchange: z.string().regex(/^[a-z0-9_]+$/).optional(),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase()).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listAlerts(db: pg.Pool, f: z.infer<typeof AlertFilter>, explorerTxUrl: string) {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.rule) where.push(`a.rule_code = ${bind(f.rule)}`);
  if (f.exchange) where.push(`a.exchange = ${bind(f.exchange)}`);
  if (f.wallet) { const p = bind(f.wallet); where.push(`(a.wallet_address = ${p} OR a.sender = ${p} OR a.recipient = ${p})`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [total, rows] = await Promise.all([
    db.query(`SELECT count(*)::int AS n FROM alerts a ${w}`, params),
    db.query(
      `SELECT a.id, a.rule_code, r.name AS rule_name, a.severity, a.source, a.occurred_at, a.exchange, a.direction, a.amount::text AS amount,
              a.usd_value::text AS usd_value, a.sender, a.recipient, a.wallet_address, a.tx_hash, a.evt_index, a.block_number, a.details, a.created_at
       FROM alerts a JOIN alert_rules r ON r.code = a.rule_code ${w}
       ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`,
      params,
    ),
  ]);
  return {
    total: total.rows[0].n as number,
    rows: rows.rows.map((r) => ({ ...r, explorer_url: r.tx_hash ? `${explorerTxUrl}${r.tx_hash}` : null })),
    limitation: WATCH_LIMITATION,
  };
}

export async function alertRules(db: pg.Pool) {
  const [rules, counts, state] = await Promise.all([
    db.query(`SELECT code, kind, name, enabled, severity, params, updated_at FROM alert_rules ORDER BY code`),
    db.query(`SELECT rule_code, count(*)::int AS n, max(occurred_at) AS latest FROM alerts GROUP BY rule_code`),
    db.query(`SELECT name, last_id::text, updated_at FROM alert_state ORDER BY name`),
  ]);
  const byRule = new Map(counts.rows.map((r) => [r.rule_code as string, r]));
  return {
    rules: rules.rows.map((r) => ({ ...r, alerts: byRule.get(r.code)?.n ?? 0, latest_alert: byRule.get(r.code)?.latest ?? null })),
    lastScan: state.rows.length ? state.rows.reduce((a, b) => (a.updated_at > b.updated_at ? a : b)).updated_at : null,
    limitation: WATCH_LIMITATION,
  };
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

export const WatchInput = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address').transform((s) => s.toLowerCase()),
  label: z.string().trim().max(60).optional().transform((s) => (s ? s : null)),
  watch: z.enum(['both', 'incoming', 'outgoing']).default('both'),
  min_amount: z.coerce.number().min(0).max(1e15).default(0),
});

export async function listWatched(db: pg.Pool) {
  const { rows } = await db.query(
    `SELECT w.address, w.label, w.watch, w.min_amount::text AS min_amount, w.enabled, w.created_at,
            (SELECT count(*)::int FROM alerts a WHERE a.rule_code = 'watched_wallet' AND a.wallet_address = w.address) AS alerts
     FROM watched_wallets w ORDER BY w.created_at DESC`,
  );
  return { rows, max: MAX_WATCHED, limitation: WATCH_LIMITATION };
}

/** Adds a wallet, or updates its settings when it is already watched. Returns null when the watchlist is full. */
export async function upsertWatched(db: pg.Pool, w: z.infer<typeof WatchInput>) {
  const { rows: [c] } = await db.query(`SELECT count(*)::int AS n, bool_or(address = $1) AS has FROM watched_wallets`, [w.address]);
  if (!c.has && c.n >= MAX_WATCHED) return null;
  const { rows: [row] } = await db.query(
    `INSERT INTO watched_wallets (address, label, watch, min_amount) VALUES ($1, $2, $3, $4)
     ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, watch = EXCLUDED.watch, min_amount = EXCLUDED.min_amount, enabled = true
     RETURNING address, label, watch, min_amount::text AS min_amount, enabled, created_at`,
    [w.address, w.label, w.watch, w.min_amount],
  );
  return row;
}

export async function removeWatched(db: pg.Pool, address: string) {
  const { rowCount } = await db.query(`DELETE FROM watched_wallets WHERE address = $1`, [address]);
  return (rowCount ?? 0) > 0;
}
