// A plain-language summary of what the dashboard shows for one period. Every sentence is built by fixed rules from numbers that the dashboard's own
// queries return (no AI, no estimates), so the text always agrees with the page. buildSummary() is pure (data in, text out) and exactly testable;
// summarize() gathers the data. The summary also says what the data cannot show (unsynced time, exchanges tracked only from a later date).
import { Decimal } from 'decimal.js';
import type pg from 'pg';
import { dataThrough, overview, type Window } from './index.js';

type Num = string | number | Decimal;

export interface ExchangeRow { exchange: string; name: string; inflow: Num; outflow: Num; net: Num; deposits: Num; withdrawals: Num; unique_wallets: Num }
export interface OverviewData {
  exchanges: ExchangeRow[];
  totals: { inflow: Num; outflow: Num; net: Num; uniqueWallets: number; exchangeTransfers: number };
  pancakeswap: {
    deod_volume: Num; buy_deod: Num; sell_deod: Num; usd_volume: Num | null; swaps: Num; buys: Num; sells: Num; unique_wallets: Num;
    largest_swap_deod: Num | null; last_price: Num | null; last_swap_time: Date | string | null;
  };
}
export interface LargestTransfer { exchange: string; direction: 'IN' | 'OUT'; amount: Num; block_time: Date | string; tx_hash: string }

export interface SummaryInput {
  window: { from: Date | null; to: Date; range: string };
  current: OverviewData;
  previous: OverviewData | null;
  largest: LargestTransfer | null;
  alertCounts: Record<string, number> | null;       // alerts raised in the period by rule code; null when alerts are not available
  dataThrough: Date | null;
  firstTransfer: { name: string; first: Date }[];   // each exchange's first recorded transfer
}

export interface Summary {
  period: string;
  headline: string;
  sections: { title: string; lines: string[] }[];
  notes: string[];
  text: string;                                      // the same content as plain text, for copying
}

const UNITS: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

/** 2,040,000 -> "2.04M", 94,355.1 -> "94.4K", 812.4 -> "812". Written by hand so it is identical everywhere. */
export function compact(v: Num): string {
  const n = new Decimal(v).abs();
  for (const [size, suffix] of UNITS) if (n.gte(size)) return `${n.div(size).toDecimalPlaces(2).toString()}${suffix}`;
  return n.toDecimalPlaces(n.lt(10) ? 2 : 0).toString();
}
const deod = (v: Num) => `${compact(v)} DEOD`;
const usd = (v: Num) => `$${compact(v)}`;
const int = (v: Num) => new Decimal(v).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const stamp = (d: Date | string) => `${new Date(d).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

export function periodLabel(w: { from: Date | null; to: Date; range: string }): string {
  switch (w.range) {
    case '1h': return 'the last hour';
    case '6h': return 'the last 6 hours';
    case '24h': return 'the last 24 hours';
    case '7d': return 'the last 7 days';
    case '30d': return 'the last 30 days';
    case 'all': return 'all recorded history';
    default: return `${day(w.from ?? w.to)} to ${day(w.to)}`;
  }
}

/** "up 12.5%" / "down 40%" / "no change" against the previous period of the same length; null when it cannot be compared. */
function change(cur: Num, prev: Num | undefined): string | null {
  if (prev === undefined) return null;
  const c = new Decimal(cur), p = new Decimal(prev);
  if (p.isZero()) return c.isZero() ? 'no change' : 'from nothing in the previous period';
  const pct = c.minus(p).div(p).times(100);
  if (pct.abs().lt(0.05)) return 'no change';
  return `${pct.gt(0) ? 'up' : 'down'} ${pct.abs().toDecimalPlaces(1).toString()}%`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

export function buildSummary(i: SummaryInput): Summary {
  const { current: c, previous: p } = i;
  const period = periodLabel(i.window);
  const net = new Decimal(c.totals.net);
  const sections: Summary['sections'] = [];
  const notes: string[] = [];

  // ---- headline
  const moved = c.exchanges.some((e) => new Decimal(e.inflow).gt(0) || new Decimal(e.outflow).gt(0)) || new Decimal(c.pancakeswap.swaps).gt(0);
  const headline = !moved
    ? `No DEOD activity is recorded for ${period}.`
    : `In ${period}, ${plural(c.totals.uniqueWallets, 'wallet')} moved DEOD on the monitored exchanges and PancakeSwap. ${deod(c.totals.inflow)} was deposited to exchanges and ${deod(c.totals.outflow)} withdrawn, so exchanges had a net ${net.gte(0) ? 'inflow' : 'outflow'} of ${deod(net)}${net.gte(0) ? ' (wallets sent more than they took out)' : ' (wallets took out more than they sent)'}.`;

  // ---- exchanges
  const active = c.exchanges.filter((e) => new Decimal(e.inflow).gt(0) || new Decimal(e.outflow).gt(0))
    .sort((a, b) => new Decimal(b.inflow).plus(b.outflow).comparedTo(new Decimal(a.inflow).plus(a.outflow)));
  const quiet = c.exchanges.filter((e) => !active.includes(e)).map((e) => e.name);
  if (active.length) {
    const lines = active.map((e) => {
      const n = new Decimal(e.net);
      return `${e.name}: ${deod(e.inflow)} in (${plural(Number(e.deposits), 'deposit')}), ${deod(e.outflow)} out (${plural(Number(e.withdrawals), 'withdrawal')}), net ${n.gte(0) ? '+' : '-'}${compact(n)}.`;
    });
    const topIn = [...active].sort((a, b) => new Decimal(b.inflow).comparedTo(a.inflow))[0]!;
    const topOut = [...active].sort((a, b) => new Decimal(b.outflow).comparedTo(a.outflow))[0]!;
    if (new Decimal(topIn.inflow).gt(0)) lines.push(`Largest inflow: ${topIn.name} (${deod(topIn.inflow)}).`);
    if (new Decimal(topOut.outflow).gt(0)) lines.push(`Largest outflow: ${topOut.name} (${deod(topOut.outflow)}).`);
    if (quiet.length) lines.push(`No activity: ${quiet.join(', ')}.`);
    sections.push({ title: 'Exchanges', lines });
  } else if (quiet.length) {
    sections.push({ title: 'Exchanges', lines: [`No recorded transfers on any monitored exchange address in this period.`] });
  }

  // ---- largest transfer
  if (i.largest) {
    const l = i.largest;
    const name = c.exchanges.find((e) => e.exchange === l.exchange)?.name ?? l.exchange;
    sections.push({ title: 'Largest single transfer', lines: [`${deod(l.amount)} ${l.direction === 'IN' ? 'deposited to' : 'withdrawn from'} ${name} at ${stamp(l.block_time)} (transaction ${l.tx_hash}).`] });
  }

  // ---- PancakeSwap
  const s = c.pancakeswap;
  if (new Decimal(s.swaps).gt(0)) {
    const buy = new Decimal(s.buy_deod), sell = new Decimal(s.sell_deod), diff = buy.minus(sell);
    const lines = [
      `${plural(Number(s.swaps), 'swap')} (${int(s.buys)} buys, ${int(s.sells)} sells) by ${plural(Number(s.unique_wallets), 'wallet')}, ${deod(s.deod_volume)}${s.usd_volume ? ` (about ${usd(s.usd_volume)})` : ''} in total.`,
      `Buys ${deod(buy)} against sells ${deod(sell)}: net ${diff.gte(0) ? 'buying' : 'selling'} of ${deod(diff)}.`,
    ];
    if (s.largest_swap_deod) lines.push(`Largest swap: ${deod(s.largest_swap_deod)}.`);
    if (s.last_price && s.last_swap_time) lines.push(`Last recorded trade price: $${new Decimal(s.last_price).toSignificantDigits(4).toString()} at ${stamp(s.last_swap_time)}.`);
    sections.push({ title: 'PancakeSwap', lines });
  } else {
    sections.push({ title: 'PancakeSwap', lines: ['No swaps recorded in this period.'] });
  }

  // ---- change against the previous period
  if (p && moved) {
    const parts: string[] = [];
    const a = change(c.totals.inflow, p.totals.inflow), b = change(c.totals.outflow, p.totals.outflow), d = change(c.pancakeswap.swaps, p.pancakeswap.swaps);
    if (a) parts.push(`deposits ${a}`);
    if (b) parts.push(`withdrawals ${b}`);
    if (d) parts.push(`swaps ${d}`);
    if (parts.length) sections.push({ title: 'Compared with the previous period of the same length', lines: [`${parts.join(', ')}.`] });
  }

  // ---- alerts
  if (i.alertCounts) {
    const names: Record<string, [string, string]> = {
      large_transfer: ['large transfer', 'large transfers'], large_swap: ['large swap', 'large swaps'],
      flow_spike: ['unusual exchange flow', 'unusual exchange flows'], watched_wallet: ['watched-wallet event', 'watched-wallet events'],
    };
    const total = Object.values(i.alertCounts).reduce((x, y) => x + y, 0);
    sections.push({
      title: 'Alerts',
      lines: [total
        ? `${plural(total, 'alert')} raised: ${Object.entries(i.alertCounts).map(([k, n]) => `${int(n)} ${(names[k] ?? [k, k])[n === 1 ? 0 : 1]}`).join(', ')}.`
        : 'No alerts were raised in this period.'],
    });
  }

  // ---- what the data cannot show
  if (i.dataThrough) {
    notes.push(`Data is synced once per finished UTC day; the latest fully synced day ends at ${stamp(i.dataThrough)}. Activity after that appears after the next sync or when you press Update today.`);
    if (i.window.from && i.window.from >= i.dataThrough) notes.push('This whole period is later than the last synced data, so it can show no activity yet.');
  } else {
    notes.push('No sync has completed yet, so there is no data.');
  }
  if (i.window.range === 'all' || (i.window.from && i.firstTransfer.length)) {
    const earliest = Math.min(...i.firstTransfer.map((f) => f.first.getTime()));
    const late = i.firstTransfer.filter((f) => f.first.getTime() - earliest > 30 * 86_400_000 && (!i.window.from || f.first > i.window.from));
    if (late.length) notes.push(`Recorded history starts later for ${late.map((f) => `${f.name} (${day(f.first)})`).join(', ')}, so their totals cover only the time since.`);
  }
  notes.push('Totals count only transfers to and from the monitored exchange addresses and swaps on the monitored PancakeSwap pools; other wallet transfers are not recorded.');

  const text = [headline, ...sections.map((x) => `${x.title}\n${x.lines.map((l) => `- ${l}`).join('\n')}`), `Notes\n${notes.map((n) => `- ${n}`).join('\n')}`].join('\n\n');
  return { period, headline, sections, notes, text };
}

// ---------------------------------------------------------------------------------------------------------------------------------

/** The window of equal length immediately before w (null for "all time", which has no previous period). */
export function previousWindow(w: Window): Window | null {
  if (!w.from) return null;
  const span = w.to.getTime() - w.from.getTime();
  return { ...w, from: new Date(w.from.getTime() - span), to: w.from };
}

export async function summarize(db: pg.Pool, w: Window): Promise<Summary> {
  const lo = w.from ?? new Date('2000-01-01T00:00:00Z');
  const prev = previousWindow(w);
  const [current, previous, largest, first, through, alerts] = await Promise.all([
    overview(db, w),
    prev ? overview(db, prev) : Promise.resolve(null),
    // f.amount in ORDER BY is the numeric column; a bare "amount" would be the text alias in the select list and sort "9.9" above "1270524".
    db.query(`SELECT f.exchange, f.direction, f.amount::text AS amount, f.block_time, f.tx_hash FROM exchange_flows f WHERE f.block_time >= $1 AND f.block_time < $2 ORDER BY f.amount DESC, f.id LIMIT 1`, [lo, w.to]),
    db.query(`SELECT e.name, min(f.block_time) AS first FROM exchange_flows f JOIN exchanges e ON e.slug = f.exchange GROUP BY e.name`),
    dataThrough(db),
    // Alerts exist only after their database update has been applied; the summary must work either way.
    db.query(`SELECT rule_code, count(*)::int AS n FROM alerts WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY rule_code ORDER BY rule_code`, [lo, w.to]).catch(() => null),
  ]);
  return buildSummary({
    window: { from: w.from, to: w.to, range: w.range },
    current: current as unknown as OverviewData,
    previous: previous as unknown as OverviewData | null,
    largest: (largest.rows[0] as LargestTransfer | undefined) ?? null,
    alertCounts: alerts ? Object.fromEntries(alerts.rows.map((r) => [r.rule_code as string, r.n as number])) : null,
    dataThrough: through,
    firstTransfer: first.rows.map((r) => ({ name: r.name as string, first: r.first as Date })),
  });
}
