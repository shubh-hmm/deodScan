#!/usr/bin/env node
// Phase-1 verification runner: executes a repo SQL file on Dune via POST /v1/sql/execute,
// polls until done, pages through results, and prints the returned schema plus sample rows.
//
// Usage:
//   node scripts/dune-run.mjs <sql-file> [--exchange mexc] [--start "2026-01-01 00:00:00"] [--end "..."]
//                             [--param key=value ...] [--rows 20] [--performance medium]
//
// Params default from config/deod.yaml. The API key is read from .env / environment only.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.dune.com/api/v1';

function loadEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Minimal extraction for the phase-1 script only; the app will use a real YAML parser.
function loadConfig() {
  const y = readFileSync(resolve(ROOT, 'config/deod.yaml'), 'utf8');
  const token = y.match(/^token:[\s\S]*?^\s+address:\s*"(0x[0-9a-fA-F]{40})"/m)?.[1];
  const exchanges = {};
  for (const m of y.matchAll(/^  ([a-z0-9_]+):\n    name: .*\n    addresses:\n      - address: "(0x[0-9a-fA-F]{40})"/gm)) {
    exchanges[m[1]] = m[2].toLowerCase();
  }
  return { token: token?.toLowerCase(), exchanges };
}

function parseArgs(argv) {
  const out = { file: null, params: {}, rows: 20, performance: 'medium' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--param') { const [k, ...v] = argv[++i].split('='); out.params[k] = v.join('='); }
    else if (a === '--exchange') out.exchange = argv[++i];
    else if (a === '--start') out.params.start_time = argv[++i];
    else if (a === '--end') out.params.end_time = argv[++i];
    else if (a === '--rows') out.rows = Number(argv[++i]);
    else if (a === '--performance') out.performance = argv[++i];
    else out.file = a;
  }
  return out;
}

// Every substituted value is validated against a strict pattern: SQL is templated, so nothing free-form gets in.
const VALIDATORS = {
  token_address: /^0x[0-9a-f]{40}$/,
  exchange_address: /^0x[0-9a-f]{40}$/,
  exchange_addresses: /^0x[0-9a-f]{40}(,0x[0-9a-f]{40})*$/,
  pool_addresses: /^0x[0-9a-f]{40}(,0x[0-9a-f]{40})*$/,
  exchange: /^[a-z0-9_]+$/,
  start_time: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  end_time: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
};

function render(sql, params) {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = params[k];
    if (v === undefined) throw new Error(`Missing template param {{${k}}}`);
    const re = VALIDATORS[k];
    if (!re) throw new Error(`No validator for param {{${k}}}; refusing to substitute`);
    if (!re.test(v)) throw new Error(`Invalid value for {{${k}}}: ${v}`);
    return v;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dune(path, init = {}, attempt = 0) {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'X-Dune-Api-Key': process.env.DUNE_API_KEY, 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Dune ${res.status} after ${attempt} retries: ${await res.text()}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    console.error(`  Dune ${res.status}; retrying in ${wait} ms`);
    await sleep(wait);
    return dune(path, init, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Dune ${res.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) throw new Error('Usage: node scripts/dune-run.mjs <sql-file> [options]');
  if (!process.env.DUNE_API_KEY) throw new Error('DUNE_API_KEY is not set (add it to .env)');

  const cfg = loadConfig();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const params = {
    token_address: cfg.token,
    exchange_addresses: Object.values(cfg.exchanges).join(','),
    pool_addresses: '0xd693c42610bd30e63b0a68a25918445a5f9a1d20,0x185d73ec966d464a40372cd7e737bb68b0b95f1f',
    start_time: '2026-01-01 00:00:00',
    end_time: now,
    ...(args.exchange ? { exchange: args.exchange, exchange_address: cfg.exchanges[args.exchange] } : {}),
    ...args.params,
  };
  if (args.exchange && !cfg.exchanges[args.exchange]) throw new Error(`Unknown exchange ${args.exchange}`);

  const sql = render(readFileSync(resolve(args.file), 'utf8'), params);
  console.log(`Executing ${basename(args.file)} (performance=${args.performance})`);

  const { execution_id } = await dune('/sql/execute', { method: 'POST', body: JSON.stringify({ sql, performance: args.performance }) });
  console.log(`  execution_id=${execution_id}`);

  let status, delay = 1000;
  for (;;) {
    status = await dune(`/execution/${execution_id}/status`);
    if (['QUERY_STATE_COMPLETED', 'QUERY_STATE_FAILED', 'QUERY_STATE_CANCELED', 'QUERY_STATE_EXPIRED', 'QUERY_STATE_COMPLETED_PARTIAL'].includes(status.state)) break;
    await sleep(delay);
    delay = Math.min(delay * 1.5, 10000);
  }
  if (status.state !== 'QUERY_STATE_COMPLETED') {
    throw new Error(`Execution ended in ${status.state}: ${JSON.stringify(status.error ?? status)}`);
  }

  const rows = [];
  let metadata, offset = 0;
  for (;;) {
    const page = await dune(`/execution/${execution_id}/results?limit=1000&offset=${offset}`);
    metadata ??= page.result?.metadata;
    rows.push(...(page.result?.rows ?? []));
    if (page.next_offset == null) break;
    offset = page.next_offset;
  }

  console.log('\nSchema:');
  (metadata?.column_names ?? []).forEach((c, i) => console.log(`  ${c.padEnd(20)} ${metadata.column_types?.[i] ?? ''}`));
  console.log(`\nRows: ${rows.length}   credits: ${status.execution_cost_credits ?? 'n/a'}`);
  console.table(rows.slice(0, args.rows));

  const outDir = resolve(ROOT, '.dune-output');
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `${basename(args.file, '.sql')}${args.exchange ? '_' + args.exchange : ''}.json`);
  writeFileSync(outFile, JSON.stringify({ execution_id, params, metadata, status, rows }, null, 2));
  console.log(`Full result saved to ${outFile}`);
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
