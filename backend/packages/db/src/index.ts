import pg from 'pg';
import { loadConfig, loadEnv, monitoredPools, type DeodConfig } from '@deod/config';
import { rawToDecimal, type SwapRow, type TransferRow } from '@deod/core';

export { migrate } from './migrate.js';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  // UTC session: date_trunc buckets must align with on-chain (UTC) block timestamps.
  if (!pool) {
    pool = new pg.Pool({ connectionString: loadEnv().DATABASE_URL, max: 10, options: '-c TimeZone=UTC' });
    // An idle connection that the server drops (database restart or shutdown) emits 'error' on the pool. Unhandled, that crashes the
    // whole process with a stack trace. Handled, the pool just discards the connection and opens a new one on the next query.
    pool.on('error', (err) => console.error(`[db pool] an idle database connection was lost: ${err.message}`));
  }
  return pool;
}

export async function closePool() {
  await pool?.end();
  pool = undefined;
}

/** Upserts config-defined exchanges, exchange addresses and pools. Admin-added rows are left untouched. */
export async function seedFromConfig(db: pg.Pool = getPool(), cfg: DeodConfig = loadConfig()) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [slug, ex] of Object.entries(cfg.exchanges)) {
      await client.query(
        `INSERT INTO exchanges (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
        [slug, ex.name],
      );
      for (const a of ex.addresses) {
        await client.query(
          `INSERT INTO exchange_addresses (exchange, address, label, address_type, source, verified, dune_label, notes)
           VALUES ($1, $2, $3, $4, 'config', $5, $6, $7)
           ON CONFLICT (chain, address) DO UPDATE SET
             exchange = EXCLUDED.exchange, address_type = EXCLUDED.address_type, dune_label = EXCLUDED.dune_label,
             notes = EXCLUDED.notes, updated_at = now()
           WHERE exchange_addresses.source = 'config'`,
          [slug, a.address, ex.name, a.address_type, a.verified, a.dune_label ?? null, a.note ?? null],
        );
      }
    }
    for (const p of monitoredPools(cfg)) {
      const [quoteSymbol, deodSide] = p.token0 === cfg.token.symbol ? [p.token1, 0] : [p.token0, 1];
      const quote = cfg.quote_tokens[quoteSymbol];
      if (!quote) throw new Error(`pool ${p.address}: quote token ${quoteSymbol} missing from quote_tokens`);
      if (deodSide === 1 && p.token1 !== cfg.token.symbol) throw new Error(`pool ${p.address} does not contain ${cfg.token.symbol}`);
      await client.query(
        `INSERT INTO dex_pools (address, version, pair, deod_address, quote_address, quote_symbol, quote_decimals, fee_tier, verification)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (address) DO UPDATE SET version = EXCLUDED.version, pair = EXCLUDED.pair,
           quote_address = EXCLUDED.quote_address, quote_symbol = EXCLUDED.quote_symbol,
           quote_decimals = EXCLUDED.quote_decimals, fee_tier = EXCLUDED.fee_tier,
           verification = EXCLUDED.verification, updated_at = now()`,
        [p.address, p.version, p.pair, cfg.token.address, quote.address, quoteSymbol, quote.decimals, p.fee_tier ?? null, p.verification ?? null],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function monitoredExchangeAddresses(db: pg.Pool = getPool()) {
  const { rows } = await db.query<{ exchange: string; address: string }>(
    `SELECT exchange, address FROM exchange_addresses WHERE monitored AND chain = 'bnb' ORDER BY address`,
  );
  return rows;
}

const BATCH = 500;

/** Inserts transfers; duplicates (same chain+tx_hash+evt_index) are skipped. Returns the number inserted. */
export async function insertTransfers(rows: TransferRow[], tokenAddress: string, decimals: number, db: pg.Pool = getPool()) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { rowCount } = await db.query(
      `INSERT INTO token_transfers (token_address, tx_hash, evt_index, block_number, block_time, from_address, to_address, amount_raw, amount, tx_from)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::bigint[], $5::timestamptz[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::text[])
       ON CONFLICT (chain, tx_hash, evt_index) DO NOTHING`,
      [
        tokenAddress,
        chunk.map((r) => r.txHash), chunk.map((r) => r.evtIndex), chunk.map((r) => r.blockNumber),
        chunk.map((r) => r.blockTime), chunk.map((r) => r.fromAddress), chunk.map((r) => r.toAddress),
        chunk.map((r) => r.amountRaw), chunk.map((r) => rawToDecimal(r.amountRaw, decimals)), chunk.map((r) => r.txFrom),
      ],
    );
    inserted += rowCount ?? 0;
  }
  return inserted;
}

/**
 * (Re)derives exchange_flows from token_transfers for every monitored exchange address.
 * Idempotent; also picks up history for exchange addresses added after the transfers were ingested.
 */
export async function deriveExchangeFlows(db: pg.Pool = getPool()) {
  const { rowCount } = await db.query(`
    INSERT INTO exchange_flows (exchange, direction, token_address, wallet_address, exchange_address,
                                amount_raw, amount, tx_hash, evt_index, block_number, block_time)
    SELECT ea.exchange, 'IN', t.token_address, t.from_address, t.to_address,
           t.amount_raw, t.amount, t.tx_hash, t.evt_index, t.block_number, t.block_time
    FROM token_transfers t JOIN exchange_addresses ea ON ea.address = t.to_address AND ea.monitored
    WHERE t.from_address <> t.to_address
    UNION ALL
    SELECT ea.exchange, 'OUT', t.token_address, t.to_address, t.from_address,
           t.amount_raw, t.amount, t.tx_hash, t.evt_index, t.block_number, t.block_time
    FROM token_transfers t JOIN exchange_addresses ea ON ea.address = t.from_address AND ea.monitored
    WHERE t.from_address <> t.to_address
    ON CONFLICT (exchange_address, tx_hash, evt_index, direction) DO NOTHING`);
  return rowCount ?? 0;
}

export async function insertSwaps(
  rows: SwapRow[],
  ctx: { deodDecimals: number; quote: Map<string, { decimals: number; usdPeg: boolean; symbol: string }> },
  db: pg.Pool = getPool(),
) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const cols = {
      version: [] as string[], pool: [] as string[], tx: [] as string[], evt: [] as number[], block: [] as number[],
      time: [] as string[], trader: [] as (string | null)[], recipient: [] as (string | null)[], txTo: [] as (string | null)[],
      side: [] as string[], tokenIn: [] as string[], inRaw: [] as string[], tokenOut: [] as string[], outRaw: [] as string[],
      deodRaw: [] as string[], deod: [] as string[], quoteToken: [] as string[], quoteRaw: [] as string[], quote: [] as string[],
      price: [] as string[], usd: [] as (string | null)[], usdBasis: [] as (string | null)[],
    };
    for (const r of chunk) {
      const q = ctx.quote.get(r.quoteTokenAddress);
      if (!q) throw new Error(`quote token ${r.quoteTokenAddress} not configured`);
      const quoteAmount = rawToDecimal(r.quoteAmountRaw, q.decimals);
      cols.version.push(r.version); cols.pool.push(r.poolAddress); cols.tx.push(r.txHash); cols.evt.push(r.evtIndex);
      cols.block.push(r.blockNumber); cols.time.push(r.blockTime); cols.trader.push(r.traderAddress);
      cols.recipient.push(r.recipientAddress); cols.txTo.push(r.txTo); cols.side.push(r.side);
      // token_in = what the trader paid into the pool; token_out = what the pool paid out.
      cols.tokenIn.push(r.side === 'BUY' ? r.quoteTokenAddress : 'DEOD');
      cols.inRaw.push(r.side === 'BUY' ? r.quoteAmountRaw : r.deodAmountRaw);
      cols.tokenOut.push(r.side === 'BUY' ? 'DEOD' : r.quoteTokenAddress);
      cols.outRaw.push(r.side === 'BUY' ? r.deodAmountRaw : r.quoteAmountRaw);
      cols.deodRaw.push(r.deodAmountRaw); cols.deod.push(rawToDecimal(r.deodAmountRaw, ctx.deodDecimals));
      cols.quoteToken.push(r.quoteTokenAddress); cols.quoteRaw.push(r.quoteAmountRaw); cols.quote.push(quoteAmount);
      cols.price.push(r.price);
      cols.usd.push(q.usdPeg ? quoteAmount : null);
      cols.usdBasis.push(q.usdPeg ? `${q.symbol.toLowerCase()}_peg` : null);
    }
    const { rowCount } = await db.query(
      `INSERT INTO dex_swaps (version, pool_address, tx_hash, evt_index, block_number, block_time, trader_address,
         recipient_address, tx_to, side, token_in, amount_in_raw, token_out, amount_out_raw, deod_amount_raw, deod_amount,
         quote_token, quote_amount_raw, quote_amount, price, usd_value, usd_basis)
       SELECT v, p, tx, e, b, t, tr, rc, tt, s,
              CASE WHEN ti = 'DEOD' THEN $23 ELSE ti END, ir,
              CASE WHEN tko = 'DEOD' THEN $23 ELSE tko END, ora, dr, d, qt, qr, q, pr, u, ub
       FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::bigint[], $6::timestamptz[], $7::text[], $8::text[],
                   $9::text[], $10::text[], $11::text[], $12::numeric[], $13::text[], $14::numeric[], $15::numeric[],
                   $16::numeric[], $17::text[], $18::numeric[], $19::numeric[], $20::numeric[], $21::numeric[], $22::text[])
         AS x(v, p, tx, e, b, t, tr, rc, tt, s, ti, ir, tko, ora, dr, d, qt, qr, q, pr, u, ub)
       ON CONFLICT (chain, tx_hash, evt_index) DO NOTHING`,
      [cols.version, cols.pool, cols.tx, cols.evt, cols.block, cols.time, cols.trader, cols.recipient, cols.txTo, cols.side,
       cols.tokenIn, cols.inRaw, cols.tokenOut, cols.outRaw, cols.deodRaw, cols.deod, cols.quoteToken, cols.quoteRaw,
       cols.quote, cols.price, cols.usd, cols.usdBasis, loadConfig().token.address],
    );
    inserted += rowCount ?? 0;
  }
  return inserted;
}

export async function recordRejections(queryName: string, executionId: string, items: { reasons: string[]; raw: unknown }[], db: pg.Pool = getPool()) {
  if (!items.length) return;
  await db.query(
    `INSERT INTO ingest_rejections (query_name, execution_id, reasons, raw)
     SELECT $1, $2, ARRAY(SELECT jsonb_array_elements_text(r->'reasons')), r->'raw' FROM jsonb_array_elements($3::jsonb) r`,
    [queryName, executionId, JSON.stringify(items)],
  );
}

export async function refreshWalletSummary(db: pg.Pool = getPool()) {
  await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY wallet_summary');
}
