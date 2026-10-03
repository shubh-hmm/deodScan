import { Decimal } from 'decimal.js';

Decimal.set({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN });

export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
export const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^\d+$/;

/** Exact raw-integer -> decimal string (no floating point). */
export function rawToDecimal(raw: string | bigint, decimals: number): string {
  const v = typeof raw === 'bigint' ? raw : BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Dune returns "2026-01-16 08:41:03.000 UTC"; returns an ISO string or null when unparseable. */
export function parseDuneTime(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) UTC$/);
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Token transfers (raw DEOD transfers touching a monitored exchange address)
// ---------------------------------------------------------------------------

export interface TransferRow {
  txHash: string;
  evtIndex: number;
  blockNumber: number;
  blockTime: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: string;
  txFrom: string | null;
}

export function normalizeTransfer(r: Record<string, unknown>): ValidationResult<TransferRow> {
  const errors: string[] = [];
  const txHash = String(r.tx_hash ?? '').toLowerCase();
  const from = String(r.from_address ?? '').toLowerCase();
  const to = String(r.to_address ?? '').toLowerCase();
  const amountRaw = String(r.amount_raw ?? '');
  const blockTime = parseDuneTime(r.block_time);
  if (!TX_HASH_RE.test(txHash)) errors.push(`invalid tx_hash: ${r.tx_hash}`);
  if (!Number.isInteger(r.evt_index) || (r.evt_index as number) < 0) errors.push(`invalid evt_index: ${r.evt_index}`);
  if (!Number.isInteger(r.block_number) || (r.block_number as number) <= 0) errors.push(`invalid block_number: ${r.block_number}`);
  if (!blockTime) errors.push(`invalid block_time: ${r.block_time}`);
  if (!ADDRESS_RE.test(from)) errors.push(`invalid from_address: ${r.from_address}`);
  if (!ADDRESS_RE.test(to)) errors.push(`invalid to_address: ${r.to_address}`);
  // UINT_RE rejects negatives, decimals and empty strings.
  if (!UINT_RE.test(amountRaw)) errors.push(`invalid amount_raw: ${r.amount_raw}`);
  const txFrom = r.tx_from == null ? null : String(r.tx_from).toLowerCase();
  if (txFrom !== null && !ADDRESS_RE.test(txFrom)) errors.push(`invalid tx_from: ${r.tx_from}`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      txHash, evtIndex: r.evt_index as number, blockNumber: r.block_number as number, blockTime: blockTime!,
      fromAddress: from, toAddress: to, amountRaw, txFrom,
    },
  };
}

// ---------------------------------------------------------------------------
// Exchange flow direction
// ---------------------------------------------------------------------------

export type FlowDirection = 'IN' | 'OUT';

/**
 * IN  = DEOD enters an exchange-controlled address; OUT = DEOD leaves it.
 * A transfer between two monitored addresses yields one leg per address.
 * A self-transfer (from == to) is neither.
 */
export function classifyFlows(
  t: Pick<TransferRow, 'fromAddress' | 'toAddress'>,
  exchangeOf: (address: string) => string | undefined,
): { exchange: string; exchangeAddress: string; walletAddress: string; direction: FlowDirection }[] {
  if (t.fromAddress === t.toAddress) return [];
  const legs: ReturnType<typeof classifyFlows> = [];
  const inEx = exchangeOf(t.toAddress);
  const outEx = exchangeOf(t.fromAddress);
  if (inEx) legs.push({ exchange: inEx, exchangeAddress: t.toAddress, walletAddress: t.fromAddress, direction: 'IN' });
  if (outEx) legs.push({ exchange: outEx, exchangeAddress: t.fromAddress, walletAddress: t.toAddress, direction: 'OUT' });
  return legs;
}

// ---------------------------------------------------------------------------
// PancakeSwap swaps
// ---------------------------------------------------------------------------

export type SwapSide = 'BUY' | 'SELL';

export interface SwapRow {
  txHash: string;
  evtIndex: number;
  blockNumber: number;
  blockTime: string;
  version: '2' | '3';
  poolAddress: string;
  side: SwapSide;
  deodAmountRaw: string;
  quoteAmountRaw: string;
  quoteTokenAddress: string;
  /** quote per DEOD, decimal string */
  price: string;
  /** Transaction signer (EOA that initiated the swap). Used as the trader address. */
  traderAddress: string;
  /** Swap event recipient as reported by Dune (`taker`); often a router/aggregator contract. */
  recipientAddress: string | null;
  txTo: string | null;
}

export interface SwapContext {
  deodAddress: string;
  deodDecimals: number;
  pools: Map<string, { version: '2' | '3'; quoteAddress: string; quoteDecimals: number }>;
}

/**
 * Direction is derived in SQL from the actual token flow of the Swap event (see queries/dune/pancakeswap_swaps.sql):
 * DEOD paid out by the pool = BUY, DEOD paid into the pool = SELL. Here we re-check that the row is consistent
 * with the configured pool (pool and version) and reject anything else, including side = UNMATCHED.
 */
export function normalizeSwap(r: Record<string, unknown>, ctx: SwapContext): ValidationResult<SwapRow> {
  const errors: string[] = [];
  const txHash = String(r.tx_hash ?? '').toLowerCase();
  const pool = String(r.pool_address ?? '').toLowerCase();
  const deodAmountRaw = String(r.deod_amount_raw ?? '');
  const quoteAmountRaw = String(r.quote_amount_raw ?? '');
  const blockTime = parseDuneTime(r.block_time);
  const txFrom = String(r.tx_from ?? '').toLowerCase();
  const side = r.side;
  const poolInfo = ctx.pools.get(pool);

  if (!TX_HASH_RE.test(txHash)) errors.push(`invalid tx_hash: ${r.tx_hash}`);
  if (!Number.isInteger(r.evt_index) || (r.evt_index as number) < 0) errors.push(`invalid evt_index: ${r.evt_index}`);
  if (!Number.isInteger(r.block_number) || (r.block_number as number) <= 0) errors.push(`invalid block_number: ${r.block_number}`);
  if (!blockTime) errors.push(`invalid block_time: ${r.block_time}`);
  if (!poolInfo) errors.push(`unexpected pool address: ${r.pool_address}`);
  else {
    if (String(r.version) !== poolInfo.version) errors.push(`version ${r.version} does not match configured pool version ${poolInfo.version}`);
  }
  if (side !== 'BUY' && side !== 'SELL') errors.push(`swap tokens do not match DEOD/quote (side=${side})`);
  if (!ADDRESS_RE.test(txFrom)) errors.push(`invalid tx_from: ${r.tx_from}`);
  if (!UINT_RE.test(deodAmountRaw) || deodAmountRaw === '0' || /^0+$/.test(deodAmountRaw)) errors.push(`invalid deod_amount_raw: ${r.deod_amount_raw}`);
  if (!UINT_RE.test(quoteAmountRaw)) errors.push(`invalid quote_amount_raw: ${r.quote_amount_raw}`);
  if (errors.length || !poolInfo) return { ok: false, errors };

  const price = new Decimal(rawToDecimal(quoteAmountRaw, poolInfo.quoteDecimals))
    .div(rawToDecimal(deodAmountRaw, ctx.deodDecimals))
    .toSignificantDigits(30)
    .toFixed();

  const taker = r.taker == null ? null : String(r.taker).toLowerCase();
  const txTo = r.tx_to == null ? null : String(r.tx_to).toLowerCase();
  return {
    ok: true,
    value: {
      txHash, evtIndex: r.evt_index as number, blockNumber: r.block_number as number, blockTime: blockTime!,
      version: poolInfo.version, poolAddress: pool, side: side as SwapSide, deodAmountRaw, quoteAmountRaw,
      quoteTokenAddress: poolInfo.quoteAddress, price, traderAddress: txFrom, recipientAddress: taker, txTo,
    },
  };
}

// ---------------------------------------------------------------------------
// Daily sync planning
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Start of the UTC day containing `d`. */
export function utcDayStart(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
}

/**
 * Whole UTC days [00:00, 24:00) that are complete and not yet synced. A day counts as complete once
 * `settleMs` has passed after its end, so Dune has indexed its last blocks. A checkpoint in the middle of a
 * day (from an older intraday sync) re-fetches that whole day; rows already stored are skipped by unique keys.
 */
export function completedDayWindows(syncedUntil: Date, now: Date, settleMs: number): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  for (let start = utcDayStart(syncedUntil); start.getTime() + DAY_MS + settleMs <= now.getTime(); start = new Date(start.getTime() + DAY_MS)) {
    out.push({ start, end: new Date(start.getTime() + DAY_MS) });
  }
  return out;
}
