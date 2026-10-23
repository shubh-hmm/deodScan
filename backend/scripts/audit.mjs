#!/usr/bin/env node
// DEODScan data audit. Cross-checks what the dashboard shows against independent sources. Read-only; spends no Dune credits.
//
//   npm run audit                 run everything
//   npm run audit -- --no-chain   skip the blockchain sampling (faster, offline)
//
// A. Database rules       duplicates, exact maths, buy/sell consistency, time order
// B. API vs fresh maths   every dashboard number recomputed independently from the raw collections (plain JavaScript and BigInt, not the
//                         database's own aggregation, so a bug in an aggregation pipeline cannot hide itself)
// C. Database vs chain    sampled transfers and swaps compared with the on-chain receipts (+ who signed each swap)
// D. Balances             stored IN - OUT against the live on-chain balance of each monitored address
// E. Pool prices          on-chain pool price vs our last trade vs CoinGecko
// F. Dune aggregates      counts and exact sums from queries/dune/verify/08 and 09 (run those first; results in .dune-output/)

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { Decimal } from 'decimal.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NO_CHAIN = process.argv.includes('--no-chain');
const API = process.env.API_BASE_URL ?? 'http://localhost:4000';
for (const line of existsSync(resolve(ROOT, '.env')) ? readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/deod_monitor';
const client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000 });
await client.connect();
const dbName = decodeURIComponent(/^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]*)/.exec(URI)?.[1] || '') || 'deod_monitor';
const db = client.db(dbName);

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
/** Exact decimal string -> BigInt scaled by 10^decimals. */
function scaledN(s, decimals) {
  const str = String(s); const [w, f = ''] = str.replace('-', '').split('.');
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals));
}
const unscale = (v) => { const neg = v < 0n; const a = neg ? -v : v; const s = (a / E18).toString() + '.' + (a % E18).toString().padStart(18, '0'); return (neg ? '-' : '') + s; };
const eqDec = (a, b) => scaled(a) === scaled(b);
const near = (a, b, rel = 1e-9) => Math.abs(Number(a) - Number(b)) <= rel * Math.max(1, Math.abs(Number(a)), Math.abs(Number(b)));
const fmt = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
/** A database Decimal128 (or string / number) as a plain decimal string. */
const plain = (v) => (v === null || v === undefined ? null : new Decimal(v.toString()).toFixed());
const iso = (d) => d.toISOString();

async function api(path) { const r = await fetch(API + path, { headers: process.env.INTERNAL_API_KEY ? { 'x-internal-key': process.env.INTERNAL_API_KEY } : {} }); if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`); return path.includes('format=csv') ? r.text() : r.json(); }

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
const byDesc = (f) => (a, b) => (f(a) < f(b) ? 1 : f(a) > f(b) ? -1 : 0);
const byAsc = (f) => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);
const shuffled = (arr) => arr.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

// ---------------------------------------------------------------- load everything once (a few thousand small documents)
const load = async (name, project) => (await db.collection(name).find().toArray()).map(project);
const transfers = await load('token_transfers', (d) => ({
  id: d._id, tx_hash: d.tx_hash, evt_index: d.evt_index, block_number: d.block_number, block_time: d.block_time, from_address: d.from_address, to_address: d.to_address,
  amount_raw: d.amount_raw, amount: plain(d.amount), tx_from: d.tx_from,
}));
const flows = await load('exchange_flows', (d) => ({
  id: d._id, exchange: d.exchange, direction: d.direction, wallet_address: d.wallet_address, exchange_address: d.exchange_address, amount_raw: d.amount_raw, amount: plain(d.amount),
  tx_hash: d.tx_hash, evt_index: d.evt_index, block_number: d.block_number, block_time: d.block_time,
}));
const swaps = await load('dex_swaps', (d) => ({
  id: d._id, version: d.version, pool_address: d.pool_address, tx_hash: d.tx_hash, evt_index: d.evt_index, block_number: d.block_number, block_time: d.block_time,
  trader_address: d.trader_address, recipient_address: d.recipient_address, side: d.side, token_in: d.token_in, token_out: d.token_out,
  deod_amount_raw: d.deod_amount_raw, deod_amount: plain(d.deod_amount), quote_amount_raw: d.quote_amount_raw, quote_amount: plain(d.quote_amount), price: plain(d.price),
  usd_value: plain(d.usd_value), usd_basis: d.usd_basis,
}));
const pools = (await db.collection('dex_pools').find().sort({ version: 1 }).toArray()).map((p) => ({ address: p.address, version: p.version, pair: p.pair, deod_address: p.deod_address, quote_address: p.quote_address, quote_decimals: p.quote_decimals }));
const exchangesList = (await db.collection('exchanges').find().sort({ name: 1 }).toArray()).map((e) => ({ slug: e._id, name: e.name }));
const monitored = (await db.collection('exchange_addresses').find({ monitored: true }).sort({ exchange: 1 }).toArray()).map((a) => ({ exchange: a.exchange, address: a.address }));
const TOKEN = pools[0]?.deod_address;
const monAddr = new Map(monitored.map((m) => [m.address, m.exchange]));
const poolBy = new Map(pools.map((p) => [p.address, p]));
const TRANSFER_T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const token0 = new Map();
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
async function loadToken0() { if (!token0.size) for (const p of pools) token0.set(p.address, '0x' + (await rpc('eth_call', [{ to: p.address, data: '0x0dfe1681' }, 'latest'])).slice(26)); }
console.log(`DEODScan audit  ${new Date().toISOString()}  database ${dbName}  token ${TOKEN}  exchanges: ${monitored.map((m) => m.exchange).join(', ')}`);

// ================================================================ A. database rules
head('A. Database rules');
{
  const dupT = transfers.length - new Set(transfers.map((r) => `${r.tx_hash}:${r.evt_index}`)).size;
  const dupS = swaps.length - new Set(swaps.map((r) => `${r.tx_hash}:${r.evt_index}`)).size;
  check('no duplicate events (transfers / swaps)', dupT === 0 && dupS === 0, `duplicates: ${dupT} / ${dupS}`);

  const negT = transfers.filter((r) => scaled(r.amount) < 0n || r.amount_raw.startsWith('-')).length;
  const negS = swaps.filter((r) => scaled(r.deod_amount) <= 0n || scaled(r.quote_amount) < 0n || new Decimal(r.price).lte(0)).length;
  check('no negative or zero amounts', negT === 0 && negS === 0, `${negT} / ${negS}`);

  const stray = transfers.filter((t) => t.from_address === t.to_address || (!monAddr.has(t.to_address) && !monAddr.has(t.from_address))).length;
  check('every stored transfer touches a monitored address and none is a self-transfer', stray === 0, `stray rows: ${stray}`);

  // Flows re-derived from the raw transfers by plain JavaScript, per exchange and direction: count and exact raw sum.
  const expect = new Map(), got = new Map();
  const add = (m, key, raw) => { const e = m.get(key) ?? { n: 0, s: 0n }; e.n++; e.s += BigInt(raw); m.set(key, e); };
  for (const t of transfers) {
    if (t.from_address === t.to_address) continue;
    if (monAddr.has(t.to_address)) add(expect, `${monAddr.get(t.to_address)}/IN`, t.amount_raw);
    if (monAddr.has(t.from_address)) add(expect, `${monAddr.get(t.from_address)}/OUT`, t.amount_raw);
  }
  for (const f of flows) add(got, `${f.exchange}/${f.direction}`, f.amount_raw);
  const norm = (m) => JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.n, v.s.toString()]));
  check('exchange_flows = raw transfers re-derived (count and exact raw sum, per exchange and direction)', norm(expect) === norm(got),
    [...expect.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}:${v.n}`).join(' '));
  const flowKeys = new Set(flows.map((f) => `${f.exchange_address}|${f.tx_hash}|${f.evt_index}|${f.direction}`));
  check('no two exchange_flows rows describe the same transfer and direction', flowKeys.size === flows.length, `${flows.length - flowKeys.size} repeated`);

  const m1 = swaps.filter((s) => scaled(s.deod_amount) !== BigInt(s.deod_amount_raw)).length;
  const m2 = swaps.filter((s) => scaledN(s.quote_amount, poolBy.get(s.pool_address).quote_decimals) !== BigInt(s.quote_amount_raw)).length;
  check('swap amounts × 10^decimals = the raw on-chain integers, exactly (exact multiplication)', m1 === 0 && m2 === 0, `mismatches: ${m1} / ${m2}`);
  const mt = transfers.filter((t) => scaled(t.amount) !== BigInt(t.amount_raw)).length;
  check('transfer amounts × 10^18 = the raw on-chain integers, exactly', mt === 0, `mismatches: ${mt}`);

  const pr = swaps.filter((s) => new Decimal(s.price).minus(new Decimal(s.quote_amount).div(s.deod_amount)).abs().div(s.price).gt(1e-9)).length;
  check('price = quote / DEOD for every swap (1e-9)', pr === 0, `mismatches: ${pr}`);

  const us = swaps.filter((s) => s.usd_basis === 'usdt_peg' && !new Decimal(s.usd_value).equals(s.quote_amount)).length;
  check('USD value = USDT amount where the peg basis applies', us === 0, `mismatches: ${us}`);

  const sd = swaps.filter((s) => {
    const p = poolBy.get(s.pool_address);
    return !p || (s.side === 'BUY' && (s.token_out !== p.deod_address || s.token_in !== p.quote_address)) || (s.side === 'SELL' && (s.token_in !== p.deod_address || s.token_out !== p.quote_address)) || s.version !== p.version;
  }).length;
  check('BUY = pool pays out DEOD, SELL = pool receives DEOD; version matches the pool', sd === 0, `inconsistent: ${sd}`);

  const backwards = (rows) => { const s = [...rows].sort((a, b) => a.block_number - b.block_number || a.evt_index - b.evt_index); let n = 0; for (let i = 1; i < s.length; i++) if (s[i].block_time < s[i - 1].block_time) n++; return n; };
  const o1 = backwards(transfers), o2 = backwards(swaps);
  check('block time never goes backwards as block number rises', o1 === 0 && o2 === 0, `${o1} / ${o2}`);

  const now = Date.now();
  const future = [...transfers, ...swaps].some((r) => r.block_time.getTime() > now);
  check('no timestamps in the future', !future);
  const range = (rows) => [new Date(Math.min(...rows.map((r) => r.block_time.getTime()))), new Date(Math.max(...rows.map((r) => r.block_time.getTime())))];
  const [mn, mx] = range(transfers), [smn, smx] = range(swaps);
  info('coverage', `transfers ${iso(mn).slice(0, 10)} → ${iso(mx).slice(0, 10)}; swaps ${iso(smn).slice(0, 10)} → ${iso(smx).slice(0, 10)}`);

  const swapDays = new Set(swaps.map((s) => iso(s.block_time).slice(0, 10)));
  const gaps = [];
  for (let t = Date.UTC(smn.getUTCFullYear(), smn.getUTCMonth(), smn.getUTCDate()); t <= smx.getTime(); t += 86400000) { const d = iso(new Date(t)).slice(0, 10); if (!swapDays.has(d)) gaps.push(d); }
  check('PancakeSwap has swaps on every day in its range (no empty days)', gaps.length === 0, gaps.length ? `empty days: ${gaps.join(', ')}` : '');

  const ws = await db.collection('wallet_summary').countDocuments();
  const real = new Set([...flows.map((f) => f.wallet_address), ...swaps.map((s) => s.trader_address)]).size;
  check('wallet summary has exactly the wallets that appear in flows or swaps', ws === real, `${ws} = ${real}`);
}

// ================================================================ B. API vs fresh maths
head('B. Dashboard numbers (API) vs independent maths');
for (const range of ['all', '30d', '7d']) {
  const ov = await api(`/api/overview?range=${range}`);
  const from = new Date(ov.window.from ?? '2000-01-01'), to = new Date(ov.window.to);
  const inWin = (r) => r.block_time >= from && r.block_time < to;
  const F = flows.filter(inWin), S = swaps.filter(inWin), T = transfers.filter(inWin);
  const sum = (rows, f) => rows.reduce((a, r) => a + scaled(f(r)), 0n);

  let ok = ov.exchanges.length === exchangesList.length;
  const lines = [];
  for (const e of exchangesList) {
    const mine = F.filter((f) => f.exchange === e.slug);
    const ins = mine.filter((f) => f.direction === 'IN'), outs = mine.filter((f) => f.direction === 'OUT');
    const a = ov.exchanges.find((x) => x.exchange === e.slug);
    ok &&= !!a && scaled(a.inflow) === sum(ins, (f) => f.amount) && scaled(a.outflow) === sum(outs, (f) => f.amount) && Number(a.deposits) === ins.length && Number(a.withdrawals) === outs.length
      && Number(a.unique_wallets) === new Set(mine.map((f) => f.wallet_address)).size;
    lines.push(`${e.name} in ${fmt(unscale(sum(ins, (f) => f.amount)))} out ${fmt(unscale(sum(outs, (f) => f.amount)))}`);
  }
  check(`[${range}] per-exchange inflow, outflow, deposits, withdrawals, unique wallets`, ok, lines.join(' | '));

  const tin = sum(F.filter((f) => f.direction === 'IN'), (f) => f.amount), tout = sum(F.filter((f) => f.direction === 'OUT'), (f) => f.amount);
  const uw = new Set([...F.map((f) => f.wallet_address), ...S.map((s) => s.trader_address)]).size;
  check(`[${range}] totals: inflow, outflow, net, transfers, unique wallets`,
    scaled(ov.totals.inflow) === tin && scaled(ov.totals.outflow) === tout && scaled(ov.totals.net) === tin - tout && ov.totals.exchangeTransfers === T.length && ov.totals.uniqueWallets === uw,
    `in ${fmt(unscale(tin))} out ${fmt(unscale(tout))} transfers ${T.length} wallets ${uw}`);

  const buys = S.filter((s) => s.side === 'BUY'), sells = S.filter((s) => s.side === 'SELL');
  const last = [...S].sort((a, b) => b.block_number - a.block_number || b.evt_index - a.evt_index)[0];
  const big = S.reduce((m, s) => (scaled(s.deod_amount) > m ? scaled(s.deod_amount) : m), 0n);
  const ps = ov.pancakeswap;
  check(`[${range}] PancakeSwap: volume, buy/sell, USD, swaps, traders, largest, last price`,
    scaled(ps.deod_volume) === sum(S, (s) => s.deod_amount) && scaled(ps.buy_deod) === sum(buys, (s) => s.deod_amount) && scaled(ps.sell_deod) === sum(sells, (s) => s.deod_amount)
    && scaled(ps.usd_volume) === sum(S.filter((s) => s.usd_value !== null), (s) => s.usd_value) && Number(ps.swaps) === S.length && Number(ps.buys) === buys.length && Number(ps.sells) === sells.length
    && Number(ps.unique_wallets) === new Set(S.map((s) => s.trader_address)).size && scaled(ps.largest_swap_deod ?? '0') === big && (!last || near(ps.last_price, last.price, 1e-12)),
    `swaps ${S.length}, volume ${fmt(unscale(sum(S, (s) => s.deod_amount)))} DEOD, USD ${fmt(unscale(sum(S.filter((s) => s.usd_value !== null), (s) => s.usd_value)))}`);

  if (range === 'all') {
    const ser = await api(`/api/flows/series?range=all`);
    const sIn = ser.rows.reduce((a, r) => a + scaled(r.inflow), 0n), sOut = ser.rows.reduce((a, r) => a + scaled(r.outflow), 0n);
    check('[all] chart series (per day) adds up to the exact total inflow and outflow', sIn === tin && sOut === tout);
    const hr = await api(`/api/flows/hourly?range=all`);
    const hi = hr.rows.reduce((a, r) => a + r.inflows, 0), ho = hr.rows.reduce((a, r) => a + r.outflows, 0);
    const nIn = F.filter((f) => f.direction === 'IN').length, nOut = F.filter((f) => f.direction === 'OUT').length;
    check('[all] hour-of-day histogram adds up to the deposit and withdrawal counts', hr.rows.length === 24 && hi === nIn && ho === nOut, `${hi} IN / ${ho} OUT over 24 hours`);
    const hourOk = hr.rows.every((r) => r.inflows === F.filter((f) => f.direction === 'IN' && f.block_time.getUTCHours() === r.hour).length && r.outflows === F.filter((f) => f.direction === 'OUT' && f.block_time.getUTCHours() === r.hour).length);
    check('[all] every hour of the histogram matches the stored transfers', hourOk);
    const csv = await api('/api/flows?range=all&format=csv');
    const rows = csv.trim().split('\r\n').slice(1);
    const hdr = csv.split('\r\n')[0].split(',');
    const ai = hdr.indexOf('amount');
    const csvSum = rows.reduce((a, l) => a + scaled(l.split(',')[ai]), 0n);
    check('[all] exchange-flow CSV: row count and exact amount total match the database', rows.length === nIn + nOut && csvSum === tin + tout, `${rows.length} rows`);
    const act = await api('/api/activity?range=all&format=csv');
    check('[all] all-activity CSV has exchange rows + swap rows', act.trim().split('\r\n').length - 1 === nIn + nOut + S.length, `${act.trim().split('\r\n').length - 1} rows = ${nIn + nOut} + ${S.length}`);

    // Top wallets recomputed by hand: volume per wallet = flows as counterparty + swaps as trader; ties broken by address.
    const agg = new Map();
    for (const r of [...F.map((f) => [f.wallet_address, f.amount, f.tx_hash]), ...S.map((s) => [s.trader_address, s.deod_amount, s.tx_hash])]) {
      const e = agg.get(r[0]) ?? { vol: 0n, txs: new Set() }; e.vol += scaled(r[1]); e.txs.add(r[2]); agg.set(r[0], e);
    }
    const dbTop = [...agg.entries()].sort(([aa, a], [bb, b]) => (b.vol > a.vol ? 1 : b.vol < a.vol ? -1 : aa < bb ? -1 : 1)).slice(0, 10).map(([addr, e]) => ({ addr, vol: e.vol, txs: e.txs.size }));
    const top = await api('/api/wallets/top?range=all&limit=10&sort=volume');
    check('[all] top-10 wallets: same wallets, order, exact volumes and transaction counts',
      top.rows.length === 10 && dbTop.every((d, i) => top.rows[i].wallet_address === d.addr && scaled(top.rows[i].volume) === d.vol && Number(top.rows[i].transactions) === d.txs),
      `#1 ${dbTop[0].addr.slice(0, 10)}… ${fmt(unscale(dbTop[0].vol))} DEOD`);
    const prof = await api(`/api/wallets/${dbTop[0].addr}`);
    const w = dbTop[0].addr;
    const pf = {
      sent: sum(flows.filter((f) => f.wallet_address === w && f.direction === 'IN'), (f) => f.amount), recv: sum(flows.filter((f) => f.wallet_address === w && f.direction === 'OUT'), (f) => f.amount),
      buy: sum(swaps.filter((s) => s.trader_address === w && s.side === 'BUY'), (s) => s.deod_amount), sell: sum(swaps.filter((s) => s.trader_address === w && s.side === 'SELL'), (s) => s.deod_amount),
    };
    check('[all] wallet profile of the #1 wallet: sent / received / bought / sold match',
      scaled(prof.summary.sent_to_exchanges) === pf.sent && scaled(prof.summary.received_from_exchanges) === pf.recv && scaled(prof.summary.swap_buy_deod) === pf.buy && scaled(prof.summary.swap_sell_deod) === pf.sell);

    // The wallet summary collection against the same by-hand totals, for EVERY wallet.
    const summary = await db.collection('wallet_summary').find().toArray();
    const mism = summary.filter((d) => { const e = agg.get(d._id); return !e || scaled(plain(d.total_deod_volume)) !== e.vol || d.transaction_count !== e.txs.size; }).length;
    check('[all] wallet_summary: exact volume and transaction count of every wallet', mism === 0 && summary.length === agg.size, `${summary.length} wallets, ${mism} different`);
  }
}

// ================================================================ C. database vs blockchain
if (NO_CHAIN) { head('C. Database vs blockchain'); info('skipped (--no-chain)'); } else {
  head('C. Database vs blockchain (sampled transactions)');
  const blockTs = new Map();
  const tsOf = async (bn) => { if (!blockTs.has(bn)) blockTs.set(bn, parseInt((await rpc('eth_getBlockByNumber', ['0x' + Number(bn).toString(16), false])).timestamp, 16) * 1000); return blockTs.get(bn); };

  // ---- transfers
  const tAll = [
    ...[...transfers].sort(byDesc((r) => BigInt(r.amount_raw))).slice(0, 10),
    ...[...transfers].sort(byAsc((r) => r.block_number)).slice(0, 10),
    ...[...transfers].sort(byDesc((r) => r.block_number)).slice(0, 10),
    ...shuffled(transfers).slice(0, 30),
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
    const mine = swaps.filter((s) => s.pool_address === p.address);
    sAll.push(...[...mine].sort(byDesc((s) => scaled(s.deod_amount))).slice(0, 10), ...[...mine].sort(byAsc((s) => s.block_number)).slice(0, 6), ...[...mine].sort(byDesc((s) => s.block_number)).slice(0, 6), ...shuffled(mine).slice(0, 18));
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
  let i = 0n, o = 0n;
  for (const t of transfers) { if (t.from_address === t.to_address) continue; if (t.to_address === m.address) i += BigInt(t.amount_raw); if (t.from_address === m.address) o += BigInt(t.amount_raw); }
  const stored = i - o, diff = onchain - stored;
  if (diff === 0n) check(`${m.exchange}: exact match to the last decimal`, true, `${(Number(onchain) / 1e18).toFixed(4)} DEOD`);
  else info(`${m.exchange}: on-chain ${(Number(onchain) / 1e18).toFixed(4)} vs stored ${(Number(stored) / 1e18).toFixed(4)}, difference ${(Number(diff) / 1e18).toFixed(4)}`, 'not an error by itself: it is either holdings the address had before the history was loaded (from 2026-07-01 for XT, BingX, Poloniex and WEEX; the amount then stays identical after every sync) or activity after the last sync (then it changes). A difference that stays the same after a fresh sync is the first kind');
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
    const last = swaps.filter((s) => s.pool_address === p.address).sort((a, b) => b.block_number - a.block_number || b.evt_index - a.evt_index)[0];
    rows.push({ pool: `V${p.version}`, onchain: price, lastSwap: Number(last.price), lastAt: iso(last.block_time).slice(0, 16) });
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
  if (!existsSync(tf) || !existsSync(sf)) info('Dune aggregates not found; run backend/queries/dune/verify/08 and 09 with backend/scripts/dune-run.mjs first');
  else {
    const T = JSON.parse(readFileSync(tf, 'utf8')), S = JSON.parse(readFileSync(sf, 'utf8'));
    const start = new Date(T.params.start_time.replace(' ', 'T') + 'Z'), end = new Date(T.params.end_time.replace(' ', 'T') + 'Z');
    info(`window ${T.params.start_time} → ${T.params.end_time} UTC`, `Dune execution ${T.execution_id.slice(0, 10)}…, ${S.execution_id.slice(0, 10)}…`);
    const inW = transfers.filter((t) => t.from_address !== t.to_address && t.block_time >= start && t.block_time < end);
    const dbT = new Map();
    const add = (dir, addr, raw) => { const k = `${dir}|${addr}`; const e = dbT.get(k) ?? { direction: dir, address: addr, n: 0, s: 0n }; e.n++; e.s += BigInt(raw); dbT.set(k, e); };
    for (const t of inW) { if (monAddr.has(t.to_address)) add('IN', t.to_address, t.amount_raw); if (monAddr.has(t.from_address)) add('OUT', t.from_address, t.amount_raw); }
    for (const d of T.rows) {
      const mine = dbT.get(`${d.direction}|${d.address}`);
      const ex = monitored.find((m) => m.address === d.address)?.exchange ?? d.address;
      check(`${ex} ${d.direction}: Dune ${d.n} transfers / ${d.raw_sum} raw = ours`, !!mine && mine.n === Number(d.n) && mine.s.toString() === d.raw_sum, mine ? `ours ${mine.n} / ${mine.s}` : 'missing in our database');
    }
    // Only addresses that were part of the saved Dune query can be compared; an exchange added later is simply not in that output.
    const queried = new Set(String(T.params.exchange_addresses ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
    const mineAll = [...dbT.values()];
    const notQueried = [...new Set(mineAll.filter((x) => !queried.has(x.address)).map((x) => monitored.find((m) => m.address === x.address)?.exchange ?? x.address))];
    if (notQueried.length) info(`not part of the saved Dune check (added after it was run): ${notQueried.join(', ')}`, 'they are verified against the chain instead (section C and the full per-transfer check)');
    check('no monitored direction exists in our database that Dune does not report', mineAll.filter((x) => queried.has(x.address)).every((x) => T.rows.some((d) => d.direction === x.direction && d.address === x.address)));
    const dbS = new Map();
    for (const s of swaps.filter((s) => s.block_time >= start && s.block_time < end)) {
      const e = dbS.get(s.pool_address) ?? { version: s.version, n: 0, buys: 0, raw: 0n }; e.n++; if (s.side === 'BUY') e.buys++; e.raw += BigInt(s.deod_amount_raw); dbS.set(s.pool_address, e);
    }
    for (const d of S.rows) {
      const mine = dbS.get(d.pool);
      check(`PancakeSwap V${d.version}: Dune ${d.n} swaps / ${d.buys} buys / ${d.deod_raw_sum} raw DEOD = ours`, !!mine && mine.n === Number(d.n) && mine.buys === Number(d.buys) && mine.raw.toString() === d.deod_raw_sum, mine ? `ours ${mine.n} / ${mine.buys} / ${mine.raw}` : 'missing');
    }
  }
}

// ================================================================ summary
console.log(`\n==== RESULT: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.INFO} informational ====`);
if (log.length) { console.log('FAILURES:'); for (const l of log) console.log(' - ' + l); }
await client.close();
process.exit(counts.FAIL ? 1 : 0);
