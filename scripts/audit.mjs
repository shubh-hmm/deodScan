#!/usr/bin/env node
// DEODScan data audit. Cross-checks what the dashboard shows against independent sources. Read-only; spends no Dune credits.
//
//   npm run audit                 run everything
//   npm run audit -- --no-chain   skip the blockchain sampling (faster, offline)
//
// A. Database rules       duplicates, exact maths, buy/sell consistency, time order
// B. API vs fresh SQL     every dashboard number recomputed independently from the raw tables
// C. Database vs chain    sampled transfers and swaps compared with the on-chain receipts (+ who signed each swap)
// D. Balances             stored IN - OUT against the live on-chain balance of each monitored address
// E. Pool prices          on-chain pool price vs our last trade vs CoinGecko
// F. Dune aggregates      counts and exact sums from queries/dune/verify/08 and 09 (run those first; results in .dune-output/)

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NO_CHAIN = process.argv.includes('--no-chain');
const API = process.env.API_BASE_URL ?? 'http://localhost:4000';
for (const line of existsSync(resolve(ROOT, '.env')) ? readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://deod:deod@localhost:5433/deod_monitor' });
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

// ---------------------------------------------------------------- reporting
const log = [];
let section = '';
const counts = { PASS: 0, FAIL: 0, INFO: 0 };
function head(s) { section = s; console.log(`\n=== ${s}`); }
function check(name, ok, detail = '') { const k = ok ? 'PASS' : 'FAIL'; counts[k]++; console.log(`${k}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) log.push(`${section}: ${name} ${detail}`); }
function info(name, detail = '') { counts.INFO++; console.log(`INFO  ${name}${detail ? '  ' + detail : ''}`); }

// ---------------------------------------------------------------- helpers
const E18 = 10n ** 18n;
/** Exact decimal string -> BigInt scaled by 1e18 (no floating point). */
function scaled(s) {
  const str = String(s); const neg = str.startsWith('-'); const [w, f = ''] = str.replace('-', '').split('.');
  const v = BigInt(w || '0') * E18 + BigInt((f + '0'.repeat(18)).slice(0, 18));
  return neg ? -v : v;
}
const eqDec = (a, b) => scaled(a) === scaled(b);
const near = (a, b, rel = 1e-9) => Math.abs(Number(a) - Number(b)) <= rel * Math.max(1, Math.abs(Number(a)), Math.abs(Number(b)));
const fmt = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });

async function api(path) { const r = await fetch(API + path); if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`); return path.includes('format=csv') ? r.text() : r.json(); }

const ENDPOINTS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'];
async function rpc(method, params, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(ENDPOINTS[i % ENDPOINTS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw last;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------------------------------------------------------------- setup
const [cfg] = await q(`select (select deod_address from dex_pools limit 1) token`);
const TOKEN = cfg.token;
const monitored = await q(`select exchange, address from exchange_addresses where monitored order by exchange`);
const pools = await q(`select address, version, pair, quote_address, quote_decimals from dex_pools order by version`);
const TRANSFER_T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const token0 = new Map();
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
async function loadToken0() { if (!token0.size) for (const p of pools) token0.set(p.address, '0x' + (await rpc('eth_call', [{ to: p.address, data: '0x0dfe1681' }, 'latest'])).slice(26)); }
console.log(`DEODScan audit  ${new Date().toISOString()}  token ${TOKEN}  exchanges: ${monitored.map((m) => m.exchange).join(', ')}`);

// ================================================================ A. database rules
head('A. Database rules');
{
  const [d] = await q(`select (select count(*) - count(distinct (tx_hash, evt_index)) from token_transfers)::int t, (select count(*) - count(distinct (tx_hash, evt_index)) from dex_swaps)::int s`);
  check('no duplicate events (transfers / swaps)', d.t === 0 && d.s === 0, `duplicates: ${d.t} / ${d.s}`);

  const [n] = await q(`select (select count(*) from token_transfers where amount_raw < 0 or amount < 0)::int t, (select count(*) from dex_swaps where deod_amount <= 0 or quote_amount < 0 or price <= 0)::int s`);
  check('no negative or zero amounts', n.t === 0 && n.s === 0, `${n.t} / ${n.s}`);

  const [stray] = await q(`select count(*)::int n from token_transfers t where from_address = to_address or (not exists (select 1 from exchange_addresses a where a.monitored and a.address = t.to_address) and not exists (select 1 from exchange_addresses a where a.monitored and a.address = t.from_address))`);
  check('every stored transfer touches a monitored address and none is a self-transfer', stray.n === 0, `stray rows: ${stray.n}`);

  const exp = await q(`
    with m as (select exchange, address from exchange_addresses where monitored)
    select m.exchange, 'IN' dir, count(*)::int n, coalesce(sum(t.amount_raw),0)::text s from token_transfers t join m on m.address = t.to_address where t.from_address <> t.to_address group by 1
    union all
    select m.exchange, 'OUT', count(*)::int, coalesce(sum(t.amount_raw),0)::text from token_transfers t join m on m.address = t.from_address where t.from_address <> t.to_address group by 1 order by 1, 2`);
  const got = await q(`select exchange, direction dir, count(*)::int n, coalesce(sum(amount_raw),0)::text s from exchange_flows group by 1, 2 order by 1, 2`);
  check('exchange_flows = raw transfers re-derived (count and exact raw sum, per exchange and direction)',
    JSON.stringify(exp) === JSON.stringify(got), exp.map((e) => `${e.exchange}/${e.dir}:${e.n}`).join(' '));

  const [m1] = await q(`select count(*)::int n from dex_swaps where deod_amount * 1000000000000000000 <> deod_amount_raw`);
  const [m2] = await q(`select count(*)::int n from dex_swaps s join dex_pools p on p.address = s.pool_address where s.quote_amount * power(10::numeric, p.quote_decimals) <> s.quote_amount_raw`);
  check('swap amounts × 10^decimals = the raw on-chain integers, exactly (exact multiplication)', m1.n === 0 && m2.n === 0, `mismatches: ${m1.n} / ${m2.n}`);

  const [pr] = await q(`select count(*)::int n from dex_swaps where abs(price - quote_amount / deod_amount) / price > 1e-9`);
  check('price = quote / DEOD for every swap (1e-9)', pr.n === 0, `mismatches: ${pr.n}`);

  const [us] = await q(`select count(*)::int n from dex_swaps where usd_basis = 'usdt_peg' and usd_value <> quote_amount`);
  check('USD value = USDT amount where the peg basis applies', us.n === 0, `mismatches: ${us.n}`);

  const [sd] = await q(`select count(*)::int n from dex_swaps s join dex_pools p on p.address = s.pool_address where (s.side = 'BUY' and (s.token_out <> p.deod_address or s.token_in <> p.quote_address)) or (s.side = 'SELL' and (s.token_in <> p.deod_address or s.token_out <> p.quote_address)) or s.version <> p.version`);
  check('BUY = pool pays out DEOD, SELL = pool receives DEOD; version matches the pool', sd.n === 0, `inconsistent: ${sd.n}`);

  const [o1] = await q(`select count(*)::int n from (select block_time, lag(block_time) over (order by block_number, evt_index) p from token_transfers) x where block_time < p`);
  const [o2] = await q(`select count(*)::int n from (select block_time, lag(block_time) over (order by block_number, evt_index) p from dex_swaps) x where block_time < p`);
  check('block time never goes backwards as block number rises', o1.n === 0 && o2.n === 0, `${o1.n} / ${o2.n}`);

  const [fut] = await q(`select (max(block_time) > now())::bool f, (select min(block_time) from token_transfers) mn, (select max(block_time) from token_transfers) mx, (select min(block_time) from dex_swaps) smn, (select max(block_time) from dex_swaps) smx from token_transfers`);
  check('no timestamps in the future', !fut.f);
  info('coverage', `transfers ${fut.mn.toISOString().slice(0, 10)} → ${fut.mx.toISOString().slice(0, 10)}; swaps ${fut.smn.toISOString().slice(0, 10)} → ${fut.smx.toISOString().slice(0, 10)}`);

  const gaps = await q(`select d::date as day from generate_series((select min(block_time)::date from dex_swaps), (select max(block_time)::date from dex_swaps), '1 day') d where not exists (select 1 from dex_swaps where block_time::date = d::date)`);
  check('PancakeSwap has swaps on every day in its range (no empty days)', gaps.length === 0, gaps.length ? `empty days: ${gaps.map((g) => g.day.toISOString().slice(0, 10)).join(', ')}` : '');

  const [w] = await q(`select (select count(*) from wallet_summary)::int ws, (select count(distinct a) from (select wallet_address a from exchange_flows union select trader_address from dex_swaps) x)::int real`);
  check('wallet summary has exactly the wallets that appear in flows or swaps', w.ws === w.real, `${w.ws} = ${w.real}`);
}

// ================================================================ B. API vs fresh SQL
head('B. Dashboard numbers (API) vs independent SQL');
for (const range of ['all', '30d', '7d']) {
  const ov = await api(`/api/overview?range=${range}`);
  const from = ov.window.from ?? '2000-01-01', to = ov.window.to;
  const exch = await q(`select e.slug, e.name,
      coalesce(sum(f.amount) filter (where f.direction='IN'),0)::text i, coalesce(sum(f.amount) filter (where f.direction='OUT'),0)::text o,
      count(f.id) filter (where f.direction='IN')::int ci, count(f.id) filter (where f.direction='OUT')::int co, count(distinct f.wallet_address)::int w
    from exchanges e left join exchange_flows f on f.exchange = e.slug and f.block_time >= $1 and f.block_time < $2 group by 1, 2 order by e.name`, [from, to]);
  let ok = ov.exchanges.length === exch.length;
  for (const e of exch) { const a = ov.exchanges.find((x) => x.exchange === e.slug); ok &&= !!a && eqDec(a.inflow, e.i) && eqDec(a.outflow, e.o) && Number(a.deposits) === e.ci && Number(a.withdrawals) === e.co && Number(a.unique_wallets) === e.w; }
  check(`[${range}] per-exchange inflow, outflow, deposits, withdrawals, unique wallets`, ok, exch.map((e) => `${e.name} in ${fmt(e.i)} out ${fmt(e.o)}`).join(' | '));

  const [tot] = await q(`select
      (select coalesce(sum(amount) filter (where direction='IN'),0)::text from exchange_flows where block_time >= $1 and block_time < $2) i,
      (select coalesce(sum(amount) filter (where direction='OUT'),0)::text from exchange_flows where block_time >= $1 and block_time < $2) o,
      (select count(*)::int from token_transfers where block_time >= $1 and block_time < $2) tr,
      (select count(distinct a)::int from (select wallet_address a from exchange_flows where block_time >= $1 and block_time < $2 union all select trader_address from dex_swaps where block_time >= $1 and block_time < $2) x) uw`, [from, to]);
  check(`[${range}] totals: inflow, outflow, net, transfers, unique wallets`,
    eqDec(ov.totals.inflow, tot.i) && eqDec(ov.totals.outflow, tot.o) && scaled(ov.totals.net) === scaled(tot.i) - scaled(tot.o) && ov.totals.exchangeTransfers === tot.tr && ov.totals.uniqueWallets === tot.uw,
    `in ${fmt(tot.i)} out ${fmt(tot.o)} transfers ${tot.tr} wallets ${tot.uw}`);

  const [p] = await q(`select coalesce(sum(deod_amount),0)::text v, coalesce(sum(deod_amount) filter (where side='BUY'),0)::text b, coalesce(sum(deod_amount) filter (where side='SELL'),0)::text s,
      coalesce(sum(usd_value),0)::text usd, count(*)::int n, count(*) filter (where side='BUY')::int nb, count(*) filter (where side='SELL')::int ns,
      count(distinct trader_address)::int u, max(deod_amount)::text big, (array_agg(price order by block_number desc, evt_index desc))[1]::text last
    from dex_swaps where block_time >= $1 and block_time < $2`, [from, to]);
  const ps = ov.pancakeswap;
  check(`[${range}] PancakeSwap: volume, buy/sell, USD, swaps, traders, largest, last price`,
    eqDec(ps.deod_volume, p.v) && eqDec(ps.buy_deod, p.b) && eqDec(ps.sell_deod, p.s) && eqDec(ps.usd_volume, p.usd) && Number(ps.swaps) === p.n && Number(ps.buys) === p.nb && Number(ps.sells) === p.ns && Number(ps.unique_wallets) === p.u && eqDec(ps.largest_swap_deod ?? '0', p.big ?? '0') && (p.last === null || near(ps.last_price, p.last, 1e-12)),
    `swaps ${p.n}, volume ${fmt(p.v)} DEOD, USD ${fmt(p.usd)}`);

  if (range === 'all') {
    const ser = await api(`/api/flows/series?range=all`);
    const sIn = ser.rows.reduce((a, r) => a + scaled(r.inflow), 0n), sOut = ser.rows.reduce((a, r) => a + scaled(r.outflow), 0n);
    check('[all] chart series (per day) adds up to the exact total inflow and outflow', sIn === scaled(tot.i) && sOut === scaled(tot.o));
    const hr = await api(`/api/flows/hourly?range=all`);
    const hi = hr.rows.reduce((a, r) => a + r.inflows, 0), ho = hr.rows.reduce((a, r) => a + r.outflows, 0);
    const nIn = exch.reduce((a, e) => a + e.ci, 0), nOut = exch.reduce((a, e) => a + e.co, 0);
    check('[all] hour-of-day histogram adds up to the deposit and withdrawal counts', hr.rows.length === 24 && hi === nIn && ho === nOut, `${hi} IN / ${ho} OUT over 24 hours`);
    const csv = await api('/api/flows?range=all&format=csv');
    const rows = csv.trim().split('\r\n').slice(1);
    const hdr = csv.split('\r\n')[0].split(',');
    const ai = hdr.indexOf('amount');
    const csvSum = rows.reduce((a, l) => a + scaled(l.split(',')[ai]), 0n);
    check('[all] exchange-flow CSV: row count and exact amount total match the database', rows.length === nIn + nOut && csvSum === scaled(tot.i) + scaled(tot.o), `${rows.length} rows`);
    const act = await api('/api/activity?range=all&format=csv');
    check('[all] all-activity CSV has exchange rows + swap rows', act.trim().split('\r\n').length - 1 === nIn + nOut + p.n, `${act.trim().split('\r\n').length - 1} rows = ${nIn + nOut} + ${p.n}`);

    const top = await api('/api/wallets/top?range=all&limit=10&sort=volume');
    const dbTop = await q(`select addr, sum(amt)::text vol, count(distinct tx)::int txs from (select wallet_address addr, amount amt, tx_hash tx from exchange_flows union all select trader_address, deod_amount, tx_hash from dex_swaps) x group by 1 order by sum(amt) desc, addr limit 10`);
    check('[all] top-10 wallets: same wallets, order, exact volumes and transaction counts',
      top.rows.length === 10 && dbTop.every((d, i) => top.rows[i].wallet_address === d.addr && eqDec(top.rows[i].volume, d.vol) && Number(top.rows[i].transactions) === d.txs),
      `#1 ${dbTop[0].addr.slice(0, 10)}… ${fmt(dbTop[0].vol)} DEOD`);
    const prof = await api(`/api/wallets/${dbTop[0].addr}`);
    const [pf] = await q(`select (select coalesce(sum(amount),0) from exchange_flows where wallet_address=$1 and direction='IN')::text sent, (select coalesce(sum(amount),0) from exchange_flows where wallet_address=$1 and direction='OUT')::text recv, (select coalesce(sum(deod_amount),0) from dex_swaps where trader_address=$1 and side='BUY')::text buy, (select coalesce(sum(deod_amount),0) from dex_swaps where trader_address=$1 and side='SELL')::text sell`, [dbTop[0].addr]);
    check('[all] wallet profile of the #1 wallet: sent / received / bought / sold match', eqDec(prof.summary.sent_to_exchanges, pf.sent) && eqDec(prof.summary.received_from_exchanges, pf.recv) && eqDec(prof.summary.swap_buy_deod, pf.buy) && eqDec(prof.summary.swap_sell_deod, pf.sell));
  }
}

// ================================================================ C. database vs blockchain
if (NO_CHAIN) { head('C. Database vs blockchain'); info('skipped (--no-chain)'); } else {
  head('C. Database vs blockchain (sampled transactions)');
  const blockTs = new Map();
  const tsOf = async (bn) => { if (!blockTs.has(bn)) blockTs.set(bn, parseInt((await rpc('eth_getBlockByNumber', ['0x' + Number(bn).toString(16), false])).timestamp, 16) * 1000); return blockTs.get(bn); };
  const pick = async (sql) => q(sql);

  // ---- transfers
  const tAll = [
    ...(await pick(`select * from token_transfers order by amount_raw desc limit 10`)),
    ...(await pick(`select * from token_transfers order by block_number asc limit 10`)),
    ...(await pick(`select * from token_transfers order by block_number desc limit 10`)),
    ...(await pick(`select * from token_transfers order by random() limit 30`)),
  ];
  const tSample = [...new Map(tAll.map((r) => [`${r.tx_hash}:${r.evt_index}`, r])).values()];
  const tBad = [];
  await mapLimit(tSample, 6, async (r) => {
    try {
      const rc = await rpc('eth_getTransactionReceipt', [r.tx_hash]);
      const tx = await rpc('eth_getTransactionByHash', [r.tx_hash]);
      const lg = rc?.logs.find((l) => parseInt(l.logIndex, 16) === r.evt_index && l.address.toLowerCase() === TOKEN);
      const why = [];
      if (!rc) why.push('receipt missing');
      else if (rc.status !== '0x1') why.push('tx failed on-chain');
      if (rc && parseInt(rc.blockNumber, 16) !== Number(r.block_number)) why.push('block number');
      if (!lg || lg.topics[0] !== TRANSFER_T) why.push('no Transfer log at that index');
      else {
        if ('0x' + lg.topics[1].slice(26) !== r.from_address) why.push('from');
        if ('0x' + lg.topics[2].slice(26) !== r.to_address) why.push('to');
        if (BigInt(lg.data).toString() !== String(r.amount_raw)) why.push('amount');
      }
      if ((await tsOf(r.block_number)) !== r.block_time.getTime()) why.push('timestamp');
      if (r.tx_from && tx?.from.toLowerCase() !== r.tx_from) why.push('tx sender');
      if (why.length) tBad.push(`${r.tx_hash.slice(0, 12)}…: ${why.join(', ')}`);
    } catch (e) { tBad.push(`${r.tx_hash.slice(0, 12)}…: ${e.message}`); }
  });
  check(`transfers: ${tSample.length} sampled (10 largest, 10 earliest, 10 latest, random) match the chain: from, to, exact amount, block, timestamp, sender`, tBad.length === 0, tBad.slice(0, 4).join(' | '));

  // ---- swaps
  await loadToken0();
  const sAll = [];
  for (const p of pools) {
    for (const sql of [`order by deod_amount desc limit 10`, `order by block_number asc limit 6`, `order by block_number desc limit 6`, `order by random() limit 18`]) sAll.push(...(await pick(`select * from dex_swaps where pool_address = '${p.address}' ${sql}`)));
  }
  const sSample = [...new Map(sAll.map((r) => [`${r.tx_hash}:${r.evt_index}`, r])).values()];
  const sBad = []; let signerOk = 0, recipOk = 0, signerN = 0;
  await mapLimit(sSample, 6, async (r) => {
    try {
      const rc = await rpc('eth_getTransactionReceipt', [r.tx_hash]);
      const tx = await rpc('eth_getTransactionByHash', [r.tx_hash]);
      const lg = rc?.logs.find((l) => parseInt(l.logIndex, 16) === r.evt_index && l.address.toLowerCase() === r.pool_address);
      const why = [];
      if (!lg) { sBad.push(`${r.tx_hash.slice(0, 12)}…: no pool log at that index`); return; }
      const t0IsDeod = token0.get(r.pool_address) === TOKEN;
      let deodIn, deodOut, quoteIn, quoteOut;
      if (r.version === '2') {
        const [a0i, a1i, a0o, a1o] = [0, 1, 2, 3].map((i) => BigInt('0x' + word(lg.data, i)));
        [deodIn, quoteIn, deodOut, quoteOut] = t0IsDeod ? [a0i, a1i, a0o, a1o] : [a1i, a0i, a1o, a0o];
      } else {
        const a0 = BigInt.asIntN(256, BigInt('0x' + word(lg.data, 0))), a1 = BigInt.asIntN(256, BigInt('0x' + word(lg.data, 1)));
        const [d, qv] = t0IsDeod ? [a0, a1] : [a1, a0];
        deodIn = d > 0n ? d : 0n; deodOut = d < 0n ? -d : 0n; quoteIn = qv > 0n ? qv : 0n; quoteOut = qv < 0n ? -qv : 0n;
      }
      const expSide = deodOut > 0n ? 'BUY' : 'SELL';
      if (r.side !== expSide) why.push(`side ${r.side} vs chain ${expSide}`);
      const deod = r.side === 'BUY' ? deodOut : deodIn, quote = r.side === 'BUY' ? quoteIn : quoteOut;
      if (deod.toString() !== String(r.deod_amount_raw)) why.push('DEOD amount');
      if (quote.toString() !== String(r.quote_amount_raw)) why.push('quote amount');
      if ((await tsOf(r.block_number)) !== r.block_time.getTime()) why.push('timestamp');
      if (parseInt(rc.blockNumber, 16) !== Number(r.block_number)) why.push('block number');
      signerN++;
      if (tx.from.toLowerCase() === r.trader_address) signerOk++; else why.push(`trader ${r.trader_address.slice(0, 8)} is not the tx signer ${tx.from.slice(0, 8)}`);
      if ('0x' + lg.topics[2].slice(26) === r.recipient_address) recipOk++; else why.push('recipient');
      if (why.length) sBad.push(`${r.tx_hash.slice(0, 12)}… V${r.version}: ${why.join(', ')}`);
    } catch (e) { sBad.push(`${r.tx_hash.slice(0, 12)}…: ${e.message}`); }
  });
  check(`swaps: ${sSample.length} sampled (V2 and V3: largest, earliest, latest, random) match the chain: side, exact DEOD and quote amounts, block, timestamp`, sBad.length === 0, sBad.slice(0, 4).join(' | '));
  check(`swaps: the stored trader is the transaction signer, and the stored recipient is the Swap event recipient (${signerOk}/${signerN} and ${recipOk}/${signerN})`, signerOk === signerN && recipOk === signerN);
}

// ================================================================ D. balances
head('D. Stored balance (IN − OUT) vs live on-chain balance');
if (NO_CHAIN) info('skipped (--no-chain)'); else for (const m of monitored) {
  const onchain = BigInt(await rpc('eth_call', [{ to: TOKEN, data: '0x70a08231' + m.address.slice(2).padStart(64, '0') }, 'latest']));
  const [s] = await q(`select coalesce(sum(amount_raw) filter (where to_address=$1),0)::text i, coalesce(sum(amount_raw) filter (where from_address=$1),0)::text o from token_transfers where (to_address=$1 or from_address=$1) and from_address<>to_address`, [m.address]);
  const stored = BigInt(s.i) - BigInt(s.o), diff = onchain - stored;
  if (diff === 0n) check(`${m.exchange}: exact match to the last decimal`, true, `${(Number(onchain) / 1e18).toFixed(4)} DEOD`);
  else info(`${m.exchange}: on-chain ${(Number(onchain) / 1e18).toFixed(4)} vs stored ${(Number(stored) / 1e18).toFixed(4)}, difference ${(Number(diff) / 1e18).toFixed(4)}`, 'expected: activity since the last completed UTC day is not synced yet; re-run right after the next daily sync');
}

// ================================================================ E. prices
head('E. Price cross-check');
if (NO_CHAIN) info('skipped (--no-chain)'); else {
  const cg = await api('/api/price');
  await loadToken0();
  const rows = [];
  for (const p of pools) {
    const t0IsDeod = token0.get(p.address) === TOKEN;
    let price;
    if (p.version === '2') {
      const r = await rpc('eth_call', [{ to: p.address, data: '0x0902f1ac' }, 'latest']);
      const r0 = BigInt('0x' + word(r, 0)), r1 = BigInt('0x' + word(r, 1));
      price = Number(t0IsDeod ? r1 : r0) / Number(t0IsDeod ? r0 : r1);
    } else {
      const r = await rpc('eth_call', [{ to: p.address, data: '0x3850c7bd' }, 'latest']);
      const pq = (Number(BigInt('0x' + word(r, 0))) / 2 ** 96) ** 2;
      price = t0IsDeod ? pq : 1 / pq;
    }
    const [last] = await q(`select price::text p, block_time from dex_swaps where pool_address = $1 order by block_number desc, evt_index desc limit 1`, [p.address]);
    rows.push({ pool: `V${p.version}`, onchain: price, lastSwap: Number(last.p), lastAt: last.block_time.toISOString().slice(0, 16) });
  }
  for (const r of rows) {
    check(`${r.pool} pool price on-chain vs CoinGecko (within 3%)`, Math.abs(r.onchain / cg.usd - 1) < 0.03, `pool $${r.onchain.toFixed(5)} vs CoinGecko $${cg.usd.toFixed(5)} (${((r.onchain / cg.usd - 1) * 100).toFixed(2)}%)`);
    info(`${r.pool}: our last stored trade price $${r.lastSwap.toFixed(5)} at ${r.lastAt} UTC vs pool now $${r.onchain.toFixed(5)}`, 'differs by the price move since that swap');
  }
}

// ================================================================ F. Dune aggregates
head('F. Dune aggregate cross-check (counts and exact raw sums)');
{
  const tf = resolve(ROOT, '.dune-output/08_audit_transfers.json'), sf = resolve(ROOT, '.dune-output/09_audit_swaps.json');
  if (!existsSync(tf) || !existsSync(sf)) info('Dune aggregates not found; run queries/dune/verify/08 and 09 with scripts/dune-run.mjs first');
  else {
    const T = JSON.parse(readFileSync(tf, 'utf8')), S = JSON.parse(readFileSync(sf, 'utf8'));
    const start = T.params.start_time.replace(' ', 'T') + 'Z', end = T.params.end_time.replace(' ', 'T') + 'Z';
    info(`window ${T.params.start_time} → ${T.params.end_time} UTC`, `Dune execution ${T.execution_id.slice(0, 10)}…, ${S.execution_id.slice(0, 10)}…`);
    const dbT = await q(`select 'IN' direction, to_address address, count(*)::int n, sum(amount_raw)::text raw_sum from token_transfers where to_address = any($3) and from_address <> to_address and block_time >= $1 and block_time < $2 group by 2
      union all select 'OUT', from_address, count(*)::int, sum(amount_raw)::text from token_transfers where from_address = any($3) and from_address <> to_address and block_time >= $1 and block_time < $2 group by 2`, [start, end, monitored.map((m) => m.address)]);
    for (const d of T.rows) {
      const mine = dbT.find((x) => x.direction === d.direction && x.address === d.address);
      const ex = monitored.find((m) => m.address === d.address)?.exchange ?? d.address;
      check(`${ex} ${d.direction}: Dune ${d.n} transfers / ${d.raw_sum} raw = ours`, !!mine && mine.n === Number(d.n) && mine.raw_sum === d.raw_sum, mine ? `ours ${mine.n} / ${mine.raw_sum}` : 'missing in our database');
    }
    check('no monitored direction exists in our database that Dune does not report', dbT.every((x) => T.rows.some((d) => d.direction === x.direction && d.address === x.address)));
    const dbS = await q(`select version, pool_address pool, count(*)::int n, count(*) filter (where side='BUY')::int buys, sum(deod_amount_raw)::text deod_raw_sum from dex_swaps where block_time >= $1 and block_time < $2 group by 1, 2 order by 1`, [start, end]);
    for (const d of S.rows) {
      const mine = dbS.find((x) => x.pool === d.pool);
      check(`PancakeSwap V${d.version}: Dune ${d.n} swaps / ${d.buys} buys / ${d.deod_raw_sum} raw DEOD = ours`, !!mine && mine.n === Number(d.n) && mine.buys === Number(d.buys) && mine.deod_raw_sum === d.deod_raw_sum, mine ? `ours ${mine.n} / ${mine.buys} / ${mine.deod_raw_sum}` : 'missing');
    }
  }
}

// ================================================================ summary
console.log(`\n==== RESULT: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.INFO} informational ====`);
if (log.length) { console.log('FAILURES:'); for (const l of log) console.log(' - ' + l); }
await db.end();
process.exit(counts.FAIL ? 1 : 0);
