// The assistant's tools. Each one is a thin, READ-ONLY wrapper around a query the dashboard already uses (@deod/analytics), so the assistant sees
// exactly what the pages show. The model chooses a tool and its arguments; the arguments are validated here and the query is run by our code, so
// the model never writes SQL and cannot reach anything but these functions. Results are capped (at most 25 rows) before the model sees them.
import { z } from 'zod';
import type pg from 'pg';
import * as A from '@deod/analytics';
import { loadConfig } from '@deod/config';
import type { ToolDef } from './llm.js';

export interface ToolContext { db: pg.Pool; now: Date }

const Range = z.enum(['1h', '6h', '24h', '7d', '30d', 'all', 'custom']);
const Period = {
  range: Range.default('7d').describe('Time period ending now: 1h, 6h, 24h, 7d, 30d, all (everything recorded) or custom (then from and to are required).'),
  from: z.string().optional().describe('Start of a custom period, ISO date or date-time in UTC, e.g. 2026-10-01.'),
  to: z.string().optional().describe('End of a custom period, ISO date or date-time in UTC. Default: now.'),
};
const Exchange = z.string().regex(/^[a-z0-9_]+$/).describe('Exchange slug, lower case: one of the monitored exchanges (see get_data_coverage).');
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('A 42-character 0x wallet address.');
const Limit = (max = 25, def = 10) => z.number().int().min(1).max(max).default(def).describe(`How many rows (at most ${max}).`);

const windowOf = (a: { range: z.infer<typeof Range>; from?: string; to?: string }, ctx: ToolContext) =>
  A.resolveWindow(A.RangeQuery.parse({ range: a.range, from: a.from, to: a.to }), ctx.now);

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d);
const cleanWindow = (w: A.Window) => ({ range: w.range, from: w.from ? w.from.toISOString() : null, to: w.to.toISOString() });
const explorer = (hash: string) => `${loadConfig().chain.explorer_tx_url}${hash}`;

const flowRow = (r: any) => ({
  time: iso(r.block_time), exchange: r.exchange, direction: r.direction, amount_deod: r.amount, wallet: r.wallet_address,
  exchange_address: r.exchange_address, tx_hash: r.tx_hash, explorer_url: explorer(r.tx_hash),
});
const swapRow = (r: any) => ({
  time: iso(r.block_time), version: r.version, side: r.side, deod_amount: r.deod_amount, usd_value: r.usd_value ?? null,
  price_usd: r.price ?? null, trader: r.trader_address, tx_hash: r.tx_hash, explorer_url: explorer(r.tx_hash),
});

export interface ToolSpec { name: string; description: string; args: z.ZodType<any>; run(args: any, ctx: ToolContext): Promise<unknown> }

export const TOOLS: ToolSpec[] = [
  {
    name: 'get_data_coverage',
    description: 'What data exists: the last fully synced time, and for every monitored exchange and for swaps the first and last recorded transfer and how many are recorded. Use it to learn the exchange names/slugs, and whenever completeness matters (all-time questions, newer exchanges, "latest" data).',
    args: z.object({}),
    async run(_a, { db }) {
      const [through, ex, sw] = await Promise.all([
        A.dataThrough(db),
        db.query(`SELECT e.slug, e.name, min(f.block_time) AS first_transfer, max(f.block_time) AS last_transfer, count(f.id)::int AS transfers
                  FROM exchanges e LEFT JOIN exchange_flows f ON f.exchange = e.slug GROUP BY e.slug, e.name ORDER BY e.name`),
        db.query(`SELECT min(block_time) AS first_swap, max(block_time) AS last_swap, count(*)::int AS swaps FROM dex_swaps`),
      ]);
      return {
        data_synced_through_utc: iso(through),
        note: 'Data is synced once per finished UTC day (or when the owner presses Update today). Activity after the last synced time may be missing. Exchanges whose first recorded transfer is recent have no earlier history in this data.',
        exchanges: ex.rows.map((r) => ({ slug: r.slug, name: r.name, first_transfer: iso(r.first_transfer), last_transfer: iso(r.last_transfer), transfers: r.transfers })),
        pancakeswap: { first_swap: iso(sw.rows[0].first_swap), last_swap: iso(sw.rows[0].last_swap), swaps: sw.rows[0].swaps },
      };
    },
  },
  {
    name: 'get_overview',
    description: 'Dashboard totals for a period: per exchange deposits (IN) and withdrawals (OUT) in DEOD with net, counts and unique wallets; totals across exchanges; and PancakeSwap volume, buys and sells, largest swap and last price.',
    args: z.object(Period),
    async run(a, ctx) {
      const w = windowOf(a, ctx);
      const o = await A.overview(ctx.db, w);
      return { period: cleanWindow(w), exchanges: o.exchanges, totals: o.totals, pancakeswap: { ...o.pancakeswap, last_swap_time: iso(o.pancakeswap.last_swap_time) } };
    },
  },
  {
    name: 'get_dashboard_summary',
    description: 'The same plain-language summary the dashboard shows for a period, including the change against the previous period of equal length (percentages), alerts raised, and notes about incomplete data. Use it for "what happened" / "compared with before" questions.',
    args: z.object(Period),
    async run(a, ctx) {
      const w = windowOf(a, ctx);
      const s = await A.summarize(ctx.db, w);
      return { period: cleanWindow(w), headline: s.headline, sections: s.sections, notes: s.notes };
    },
  },
  {
    name: 'get_exchange_stats',
    description: 'One exchange over a period: deposits, withdrawals, net, counts, unique wallets, largest deposit and withdrawal.',
    args: z.object({ exchange: Exchange, ...Period }),
    async run(a, ctx) {
      const w = windowOf(a, ctx);
      return { period: cleanWindow(w), exchange: a.exchange, stats: await A.exchangeStats(ctx.db, a.exchange, w) };
    },
  },
  {
    name: 'list_exchange_transfers',
    description: 'Individual deposits (IN: a wallet sent DEOD to an exchange) and withdrawals (OUT: the exchange sent DEOD to a wallet), newest first or largest first, with transaction hashes. Filter by exchange, direction, wallet or minimum amount.',
    args: z.object({
      ...Period, exchange: Exchange.optional(), direction: z.enum(['IN', 'OUT']).optional(), wallet: Address.optional(),
      min_amount: z.number().nonnegative().optional().describe('Minimum DEOD amount.'), sort: z.enum(['time', 'amount']).default('amount'), limit: Limit(),
    }),
    async run(a, ctx) {
      const w = windowOf(a, ctx);
      const f = A.FlowFilter.parse({ exchange: a.exchange, direction: a.direction, wallet: a.wallet, min: a.min_amount, sort: a.sort, limit: a.limit, offset: 0 });
      const r = await A.listFlows(ctx.db, w, f);
      return { period: cleanWindow(w), total_matching: r.total, shown: r.rows.length, transfers: r.rows.map(flowRow) };
    },
  },
  {
    name: 'top_exchange_wallets',
    description: 'The wallets that deposited the most to (IN) or withdrew the most from (OUT) one exchange in a period.',
    args: z.object({ exchange: Exchange, direction: z.enum(['IN', 'OUT']), ...Period, limit: Limit() }),
    async run(a, ctx) {
      const w = windowOf(a, ctx);
      const rows = await A.topExchangeWallets(ctx.db, a.exchange, a.direction, w, a.limit);
      return { period: cleanWindow(w), exchange: a.exchange, direction: a.direction, wallets: rows.map((r) => ({ wallet: r.wallet_address, total_deod: r.total, transfers: Number(r.transfers), largest_deod: r.largest, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen) })) };
    },
  },
  {
    name: 'get_pancakeswap_stats',
    description: 'PancakeSwap activity for a period: swaps, buys and sells in DEOD and USD, unique traders, largest swap, last price. version 2, 3 or all.',
    args: z.object({ ...Period, version: z.enum(['2', '3', 'all']).default('all') }),
    async run(a, ctx) {
      const w = windowOf(a, ctx);
      const s = await A.pancakeStats(ctx.db, w, a.version);
      return { period: cleanWindow(w), version: a.version, stats: { ...s, last_swap_time: iso(s.last_swap_time) } };
    },
  },
  {
    name: 'list_swaps',
    description: 'Individual PancakeSwap swaps (BUY: the trader received DEOD, SELL: the trader sold DEOD), newest or largest first, with transaction hashes. The trader is the transaction signer.',
    args: z.object({
      ...Period, side: z.enum(['BUY', 'SELL']).optional(), version: z.enum(['2', '3', 'all']).default('all'), wallet: Address.optional(),
      min_amount: z.number().nonnegative().optional().describe('Minimum DEOD amount.'), sort: z.enum(['time', 'amount']).default('amount'), limit: Limit(),
    }),
    async run(a, ctx) {
      const w = windowOf(a, ctx);
      const f = A.SwapFilter.parse({ version: a.version, side: a.side, wallet: a.wallet, min: a.min_amount, sort: a.sort, limit: a.limit, offset: 0 });
      const r = await A.listSwaps(ctx.db, w, f);
      return { period: cleanWindow(w), total_matching: r.total, shown: r.rows.length, swaps: r.rows.map(swapRow) };
    },
  },
  {
    name: 'top_wallets',
    description: 'Most active wallets in a period across exchanges and PancakeSwap, ranked by total DEOD volume, number of transactions, largest transfer, DEOD sent to exchanges, DEOD received from exchanges, buying or selling.',
    args: z.object({ ...Period, sort: z.enum(['volume', 'transactions', 'largest', 'sent_to_exchanges', 'received_from_exchanges', 'buy', 'sell']).default('volume'), limit: Limit() }),
    async run(a, ctx) {
      const w = windowOf(a, ctx);
      const rows = await A.topWallets(ctx.db, w, A.TopWalletQuery.parse({ sort: a.sort, limit: a.limit }));
      return { period: cleanWindow(w), ranked_by: a.sort, wallets: rows };
    },
  },
  {
    name: 'get_wallet_profile',
    description: 'One wallet: totals sent to and received from the exchanges, swaps, first and last seen, and its 15 most recent recorded transactions. Only transfers with the monitored exchange addresses and swaps on the monitored pools are recorded, so the wallet\'s other transfers are not visible.',
    args: z.object({ address: Address }),
    async run(a, ctx) {
      const address = a.address.toLowerCase();
      const [profile, timeline] = await Promise.all([A.walletProfile(ctx.db, address), A.walletTimeline(ctx.db, address, 15, 0)]);
      return {
        address, profile, recent_activity: timeline.map((t: any) => ({ ...t, block_time: iso(t.block_time), explorer_url: explorer(t.tx_hash) })),
        limitation: 'Only recorded activity: transfers with monitored exchange addresses and swaps on the monitored PancakeSwap pools.',
      };
    },
  },
  {
    name: 'list_alerts',
    description: 'Alerts the system raised (large transfers, large swaps, unusual exchange flows, watched wallets), newest first, optionally for one rule, exchange or wallet.',
    args: z.object({ rule: z.enum(['large_transfer', 'large_swap', 'flow_spike', 'watched_wallet']).optional(), exchange: Exchange.optional(), wallet: Address.optional(), limit: Limit() }),
    async run(a, ctx) {
      const r = await A.listAlerts(ctx.db, A.AlertFilter.parse({ rule: a.rule, exchange: a.exchange, wallet: a.wallet, limit: a.limit, offset: 0 }), loadConfig().chain.explorer_tx_url);
      return { total_matching: r.total, shown: r.rows.length, alerts: r.rows.map((x: any) => ({ rule: x.rule_name, severity: x.severity, time: iso(x.occurred_at), exchange: x.exchange, direction: x.direction, amount_deod: x.amount, sender: x.sender, recipient: x.recipient, tx_hash: x.tx_hash, explorer_url: x.explorer_url, details: x.details })) };
    },
  },
];

/** JSON Schema for each tool, in the shape the model API expects (optional fields stay optional). */
export function toolDefs(): ToolDef[] {
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.args, { io: 'input' }) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}
