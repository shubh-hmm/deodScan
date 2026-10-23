// Alert list, alert rules and the wallet watchlist. Everything is read from (or, for the watchlist, written to) the application database;
// nothing here calls Dune or any other service.
import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import { decStr, decStrOrNull, toDec128 } from '@deod/db';

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

export async function listAlerts(db: Db, f: z.infer<typeof AlertFilter>, explorerTxUrl: string) {
  const filter: Document = {
    ...(f.rule ? { rule_code: f.rule } : {}), ...(f.exchange ? { exchange: f.exchange } : {}),
    ...(f.wallet ? { $or: [{ wallet_address: f.wallet }, { sender: f.wallet }, { recipient: f.wallet }] } : {}),
  };
  const alerts = db.collection('alerts');
  const [total, rows, rules] = await Promise.all([
    alerts.countDocuments(filter),
    alerts.find(filter).sort({ occurred_at: -1, _id: -1 }).skip(f.offset).limit(f.limit).toArray(),
    db.collection('alert_rules').find().toArray(),
  ]);
  const names = new Map(rules.map((r) => [r._id as unknown as string, r.name as string]));
  return {
    total,
    rows: rows.map((a) => ({
      id: a._id as unknown as number, rule_code: a.rule_code as string, rule_name: names.get(a.rule_code) ?? (a.rule_code as string), severity: a.severity as string, source: a.source as string,
      occurred_at: a.occurred_at as Date, exchange: (a.exchange as string | null) ?? null, direction: (a.direction as string | null) ?? null, amount: decStr(a.amount),
      usd_value: decStrOrNull(a.usd_value), sender: (a.sender as string | null) ?? null, recipient: (a.recipient as string | null) ?? null,
      wallet_address: (a.wallet_address as string | null) ?? null, tx_hash: (a.tx_hash as string | null) ?? null, evt_index: (a.evt_index as number | null) ?? null,
      block_number: (a.block_number as number | null) ?? null, details: (a.details as Record<string, unknown>) ?? {}, created_at: a.created_at as Date,
      explorer_url: a.tx_hash ? `${explorerTxUrl}${a.tx_hash}` : null,
    })),
    limitation: WATCH_LIMITATION,
  };
}

export async function alertRules(db: Db) {
  const [rules, counts, state] = await Promise.all([
    db.collection('alert_rules').find().sort({ _id: 1 }).toArray(),
    db.collection('alerts').aggregate([{ $group: { _id: '$rule_code', n: { $sum: 1 }, latest: { $max: '$occurred_at' } } }]).toArray(),
    db.collection('alert_state').find().sort({ _id: 1 }).toArray(),
  ]);
  const byRule = new Map(counts.map((r) => [r._id as string, r]));
  const scans = state.map((s) => s.updated_at as Date);
  return {
    rules: rules.map((r) => ({
      code: r._id as unknown as string, kind: r.kind as string, name: r.name as string, enabled: r.enabled as boolean, severity: r.severity as string, params: r.params as Record<string, unknown>,
      updated_at: r.updated_at as Date, alerts: (byRule.get(r._id as unknown as string)?.n as number) ?? 0, latest_alert: (byRule.get(r._id as unknown as string)?.latest as Date | undefined) ?? null,
    })),
    lastScan: scans.length ? scans.reduce((a, b) => (a > b ? a : b)) : null,
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

const watchedRow = (w: Document) => ({
  address: w._id as string, label: (w.label as string | null) ?? null, watch: w.watch as string, min_amount: decStr(w.min_amount), enabled: w.enabled as boolean, created_at: w.created_at as Date,
});

export async function listWatched(db: Db) {
  const [rows, counts] = await Promise.all([
    db.collection('watched_wallets').find().sort({ created_at: -1 }).toArray(),
    db.collection('alerts').aggregate([{ $match: { rule_code: 'watched_wallet' } }, { $group: { _id: '$wallet_address', n: { $sum: 1 } } }]).toArray(),
  ]);
  const byWallet = new Map(counts.map((c) => [c._id as string, c.n as number]));
  return { rows: rows.map((w) => ({ ...watchedRow(w), alerts: byWallet.get(w._id as unknown as string) ?? 0 })), max: MAX_WATCHED, limitation: WATCH_LIMITATION };
}

/** Adds a wallet, or updates its settings when it is already watched. Returns null when the watchlist is full. */
export async function upsertWatched(db: Db, w: z.infer<typeof WatchInput>) {
  const col = db.collection('watched_wallets');
  const [n, has] = await Promise.all([col.countDocuments(), col.countDocuments({ _id: w.address as never }, { limit: 1 })]);
  if (!has && n >= MAX_WATCHED) return null;
  const row = await col.findOneAndUpdate(
    { _id: w.address as never },
    { $set: { address: w.address, label: w.label, watch: w.watch, min_amount: toDec128(w.min_amount), enabled: true }, $setOnInsert: { created_at: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
  return watchedRow(row!);
}

export async function removeWatched(db: Db, address: string) {
  return (await db.collection('watched_wallets').deleteOne({ _id: address as never })).deletedCount > 0;
}
