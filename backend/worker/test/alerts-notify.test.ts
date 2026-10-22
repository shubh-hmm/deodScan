// Telegram notifications: message content and the Telegram client are tested with a fake `fetch`; delivery bookkeeping (send once, retry,
// caps) runs against a THROWAWAY database. No real Telegram call is ever made and deod_monitor is never touched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '@deod/config';
import { migrate } from '@deod/db';
import { StopRun, formatAlertMessage, notifyPending, telegramSender, type AlertForMessage, type Sender } from '../src/alerts/notify.js';
import { syncAlertRules } from '../src/alerts/scan.js';

const EXPLORER = 'https://bscscan.com/tx/';
const TX = `0x${'ab'.repeat(32)}`;
const base: AlertForMessage = {
  rule_name: 'Large exchange transfer', severity: 'high', rule_code: 'large_transfer', occurred_at: new Date('2026-10-18T15:28:03Z'), exchange: 'toobit', direction: 'OUT',
  amount: '1270524.830000000000000000', usd_value: null, sender: '0xb0b1177e8b32bfb9744c50f1350c6a614cc1aa77', recipient: '0x2222222222222222222222222222222222222222',
  wallet_address: '0x2222222222222222222222222222222222222222', tx_hash: TX, block_number: 127999999, details: {},
};

describe('alert message', () => {
  it('contains amount, sender, recipient, time, transaction hash and explorer link', () => {
    const t = formatAlertMessage(base, EXPLORER, () => 'Toobit');
    expect(t).toContain('Large exchange transfer (high)');
    expect(t).toContain('Amount: 1,270,524.83 DEOD');
    expect(t).toContain('Toobit · OUT');
    expect(t).toContain('From: 0xb0b1177e8b32bfb9744c50f1350c6a614cc1aa77');
    expect(t).toContain('To: 0x2222222222222222222222222222222222222222');
    expect(t).toContain('Time: 2026-10-18 15:28 UTC');
    expect(t).toContain(`Tx: ${TX}`);
    expect(t).toContain(`${EXPLORER}${TX}`);
  });
  it('shows the USD value for swaps and names the pool venue', () => {
    const t = formatAlertMessage({ ...base, rule_name: 'Large PancakeSwap swap', rule_code: 'large_swap', exchange: null, direction: 'SELL', amount: '94355.15', usd_value: '1605.5' }, EXPLORER);
    expect(t).toContain('Amount: 94,355.15 DEOD (about $1605.50)');
    expect(t).toContain('PancakeSwap · SELL');
  });
  it('describes a daily-flow alert with its baseline instead of a transaction', () => {
    const t = formatAlertMessage({
      ...base, rule_name: 'Unusual exchange flow', rule_code: 'flow_spike', tx_hash: null, sender: null, recipient: null, amount: '2568755.44', direction: 'OUT', exchange: 'mexc',
      details: { day: '2026-10-15', ratio: '198.57', tracked_days: 30, baseline_mean: '12936.5' },
    }, EXPLORER, () => 'MEXC');
    expect(t).toContain('Day: 2026-10-15 (UTC, finished day total)');
    expect(t).toContain('198.57x its 30-day daily average of 12,936.5 DEOD');
    expect(t).not.toContain('Tx:');
  });
  it('names the watched wallet only for watched-wallet alerts, and never adds labels such as whale or bot', () => {
    const w = formatAlertMessage({ ...base, rule_code: 'watched_wallet', rule_name: 'Watched wallet activity' }, EXPLORER);
    expect(w).toContain('Watched wallet: 0x2222222222222222222222222222222222222222');
    expect(formatAlertMessage(base, EXPLORER)).not.toContain('Watched wallet');
    expect(w.toLowerCase()).not.toMatch(/whale|bot\b|insider/);
  });
});

describe('Telegram client', () => {
  const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  const res = (status: number, body: object = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts the text to the chat and succeeds on 200', async () => {
    let seen: { url: string; body: any } | null = null;
    const s = telegramSender(TOKEN, '987654321', (async (url: string, init: RequestInit) => { seen = { url, body: JSON.parse(String(init.body)) }; return res(200, { ok: true }); }) as unknown as typeof fetch);
    await s.send('hello');
    expect(seen!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(seen!.body).toMatchObject({ chat_id: '987654321', text: 'hello', disable_web_page_preview: true });
  });
  it('turns a rejected message into an error with Telegram\'s reason', async () => {
    const s = telegramSender(TOKEN, '1', (async () => res(400, { description: 'Bad Request: chat not found' })) as unknown as typeof fetch);
    await expect(s.send('x')).rejects.toThrow('Telegram answered 400: Bad Request: chat not found');
    await s.send('x').catch((e) => expect(e).not.toBeInstanceOf(StopRun));
  });
  it('stops the whole run on a rate limit or server error', async () => {
    for (const status of [429, 502]) {
      const s = telegramSender(TOKEN, '1', (async () => res(status)) as unknown as typeof fetch);
      await expect(s.send('x')).rejects.toBeInstanceOf(StopRun);
    }
  });
  it('never puts the bot token into an error message', async () => {
    const s = telegramSender(TOKEN, '1', (async () => { throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`); }) as unknown as typeof fetch);
    const e = await s.send('x').catch((x: Error) => x);
    expect(e).toBeInstanceOf(StopRun);
    expect(String((e as Error).message)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

let admin: pg.Client | null = null;
let baseUrl = '';
try {
  baseUrl = loadEnv().DATABASE_URL;
  admin = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
} catch {
  admin = null;
}

describe.skipIf(!admin)('notification delivery on a throwaway database', () => {
  const dbName = `deod_notify_test_${Date.now()}`;
  let pool: pg.Pool;
  let seq = 0;
  const sent: string[] = [];
  const okSender: Sender = { channel: 'telegram', send: async (t) => { sent.push(t); } };
  const failing = (e: Error): Sender => ({ channel: 'telegram', send: async () => { throw e; } });

  async function addAlert(amount = '600000'): Promise<number> {
    seq += 1;
    const { rows } = await pool.query(
      `INSERT INTO alerts (dedup_key, rule_code, severity, source, occurred_at, exchange, direction, amount, sender, recipient, wallet_address, tx_hash, evt_index, block_number)
       VALUES ($1, 'large_transfer', 'high', 'exchange_flow', now(), 'mexc', 'IN', $2, $3, $4, $3, $5, 1, $6) RETURNING id`,
      [`t:${seq}`, amount, '0x1ffbdf86dcd09980ee8e2e89a301c5e15f2d49c7', '0x4982085c9e2f89f2ecb8131eca71afad896e89cb', `0x${seq.toString(16).padStart(64, '0')}`, 1000 + seq]);
    return rows[0].id;
  }
  const log = async (id: number) => (await pool.query(`SELECT status, attempts, error FROM notification_log WHERE alert_id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await admin!.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${dbName}`), max: 4 });
    await migrate(pool);
    await syncAlertRules(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('does nothing and writes nothing when Telegram is not configured', async () => {
    await addAlert();
    const r = await notifyPending(pool, null);
    expect(r).toMatchObject({ sent: 0, failed: 0, remaining: 0 });
    expect(r.skipped).toMatch(/not configured/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM notification_channels`)).rows[0].n).toBe(0);
  });

  it('does not send alerts that existed before the channel was switched on', async () => {
    const r = await notifyPending(pool, okSender);              // first run with a sender: switches the channel on
    expect(r.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('sends a new alert exactly once', async () => {
    const id = await addAlert('700000');
    expect((await notifyPending(pool, okSender)).sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Amount: 700,000 DEOD');
    expect((await log(id)).status).toBe('sent');
    expect((await notifyPending(pool, okSender)).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('records a failed delivery and retries it later, then marks it sent', async () => {
    const id = await addAlert();
    const r = await notifyPending(pool, failing(new Error('Telegram answered 400: Bad Request: chat not found')));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(await log(id)).toMatchObject({ status: 'failed', attempts: 1, error: 'Telegram answered 400: Bad Request: chat not found' });
    expect((await notifyPending(pool, okSender)).sent).toBe(1);
    expect(await log(id)).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('gives up on an alert after the maximum number of attempts', async () => {
    const id = await addAlert();
    for (let i = 0; i < 3; i++) await notifyPending(pool, failing(new Error('nope')), { maxAttempts: 3 });
    expect((await log(id)).attempts).toBe(3);
    const r = await notifyPending(pool, okSender, { maxAttempts: 3 });
    expect(r.sent).toBe(0);
    expect((await log(id)).status).toBe('failed');
  });

  it('stops the run on a rate limit and leaves the rest for the next run', async () => {
    await pool.query(`DELETE FROM alerts`);
    for (let i = 0; i < 3; i++) await addAlert();
    const r = await notifyPending(pool, failing(new StopRun('Telegram answered 429')));
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(2);
    expect(r.skipped).toMatch(/429/);
    expect((await notifyPending(pool, okSender)).sent).toBe(3);
  });

  it('sends at most maxPerRun messages per run, oldest first, and the rest on the next run', async () => {
    await pool.query(`DELETE FROM alerts`);
    sent.length = 0;
    for (let i = 0; i < 5; i++) await addAlert(String(600000 + i));
    const a = await notifyPending(pool, okSender, { maxPerRun: 2 });
    expect(a).toMatchObject({ sent: 2, remaining: 3 });
    expect(sent[0]).toContain('600,000'); expect(sent[1]).toContain('600,001');
    expect((await notifyPending(pool, okSender, { maxPerRun: 2 })).sent).toBe(2);
    expect((await notifyPending(pool, okSender, { maxPerRun: 2 })).sent).toBe(1);
    expect(sent).toHaveLength(5);
    expect(new Set(sent).size).toBe(5);
  });
});
