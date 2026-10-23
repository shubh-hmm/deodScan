// Alert delivery to Telegram people: message content and the Telegram client are tested with a fake `fetch`; delivery bookkeeping (who gets
// what, once, retries, caps) runs against a THROWAWAY database with a fake Telegram. Nothing real is ever sent and deod_monitor is untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, nextIds, toDec128 } from '@deod/db';
import { formatAlertMessage, notifyPending, type AlertForMessage } from '../src/alerts/notify.js';
import { StopRun, TelegramError, telegramApi, type TelegramApi } from '../src/telegram/api.js';
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
  const api = (f: (url: string, init: RequestInit) => Promise<Response>) => telegramApi(TOKEN, f as unknown as typeof fetch);

  it('posts the text to the chat and succeeds on 200', async () => {
    let seen: { url: string; body: any } | null = null;
    await api(async (url, init) => { seen = { url, body: JSON.parse(String(init.body)) }; return res(200, { ok: true, result: true }); }).sendMessage(987654321, 'hello');
    expect(seen!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(seen!.body).toMatchObject({ chat_id: 987654321, text: 'hello', disable_web_page_preview: true });
  });
  it('turns a refused call into an error with Telegram\'s reason, and flags a blocked bot', async () => {
    const e = await api(async () => res(403, { description: 'Forbidden: bot was blocked by the user' })).sendMessage(1, 'x').catch((x) => x);
    expect(e).toBeInstanceOf(TelegramError);
    expect(e.message).toBe('Telegram answered 403: Forbidden: bot was blocked by the user');
    expect(e.botBlocked).toBe(true);
    expect(await api(async () => res(400, { description: 'chat not found' })).sendMessage(1, 'x').catch((x) => x)).toMatchObject({ botBlocked: false });
  });
  it('stops the whole run on a rate limit or server error', async () => {
    for (const status of [429, 502]) await expect(api(async () => res(status)).sendMessage(1, 'x')).rejects.toBeInstanceOf(StopRun);
  });
  it('never puts the bot token into an error message', async () => {
    const e = await api(async () => { throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`); }).sendMessage(1, 'x').catch((x: Error) => x);
    expect(e).toBeInstanceOf(StopRun);
    expect(String((e as Error).message)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

const scratch = await createScratchDb('deod_notify_test');

describe.skipIf(!scratch)('alert delivery to people on a throwaway database', () => {
  const pool = scratch!.db;
  let seq = 0;

  type Sent = { chat: string; text: string };
  const fake = (opts: { failFor?: string; error?: Error } = {}) => {
    const sent: Sent[] = [];
    const api = { sendMessage: async (chat: number | string, text: string) => {
      if (opts.error && (!opts.failFor || String(chat) === opts.failFor)) throw opts.error;
      sent.push({ chat: String(chat), text });
    } } as unknown as TelegramApi;
    return { api, sent };
  };

  async function addUser(chat: number, status: 'new' | 'authorized' | 'subscribed' | 'blocked', subscribedAgoMs = 60_000) {
    await pool.collection('telegram_users').replaceOne({ _id: chat as never }, {
      chat_id: chat, status, failed_attempts: 0, locked_until: null, authorized_at: null, subscribed_at: status === 'subscribed' ? new Date(Date.now() - subscribedAgoMs) : null,
      created_at: new Date(), updated_at: new Date(),
    }, { upsert: true });
  }
  async function addAlert(amount = '600000'): Promise<number> {
    seq += 1;
    const id = await nextIds(pool, 'alerts');
    await pool.collection('alerts').insertOne({
      _id: id as never, dedup_key: `t:${seq}`, rule_code: 'large_transfer', severity: 'high', source: 'exchange_flow', occurred_at: new Date(), exchange: 'mexc', direction: 'IN',
      amount: toDec128(amount), usd_value: null, sender: '0x1ffbdf86dcd09980ee8e2e89a301c5e15f2d49c7', recipient: '0x4982085c9e2f89f2ecb8131eca71afad896e89cb',
      wallet_address: '0x1ffbdf86dcd09980ee8e2e89a301c5e15f2d49c7', tx_hash: `0x${seq.toString(16).padStart(64, '0')}`, evt_index: 1, block_number: 1000 + seq, details: {}, created_at: new Date(),
    });
    return id;
  }
  const log = (id: number, chat: number) => pool.collection('notification_log').findOne({ alert_id: id, recipient: String(chat) }, { projection: { status: 1, attempts: 1, error: 1, _id: 0 } });
  const reset = async () => { await pool.collection('alerts').deleteMany({}); await pool.collection('notification_log').deleteMany({}); await pool.collection('telegram_users').deleteMany({}); };

  beforeAll(async () => {
    await syncAlertRules(pool);
  }, 60_000);

  afterAll(() => scratch?.drop());

  it('does nothing when the bot is not configured', async () => {
    const r = await notifyPending(pool, null);
    expect(r).toMatchObject({ sent: 0, failed: 0, remaining: 0 });
    expect(r.skipped).toMatch(/not configured/);
  });

  it('sends nothing when nobody has said yes to alerts', async () => {
    await reset();
    await addUser(1, 'new'); await addUser(2, 'authorized'); await addUser(3, 'blocked');
    await addAlert();
    const { api, sent } = fake();
    const r = await notifyPending(pool, api);
    expect(r.recipients).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('sends a new alert to every subscribed person exactly once, and to nobody else', async () => {
    await reset();
    await addUser(10, 'subscribed'); await addUser(11, 'subscribed'); await addUser(12, 'authorized'); await addUser(13, 'new'); await addUser(14, 'blocked');
    const id = await addAlert('700000');
    const { api, sent } = fake();
    const r = await notifyPending(pool, api);
    expect(r).toMatchObject({ sent: 2, failed: 0, recipients: 2 });
    expect(sent.map((s) => s.chat).sort()).toEqual(['10', '11']);
    expect(sent[0]!.text).toContain('Amount: 700,000 DEOD');
    expect((await log(id, 10))!.status).toBe('sent');
    expect(await log(id, 12)).toBeNull();
    expect((await notifyPending(pool, api)).sent).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('sends a person only the alerts created after they said yes', async () => {
    await reset();
    await addAlert('600001');                              // created before anyone subscribed
    await addUser(20, 'subscribed', -60_000);              // subscribed one minute from now: the old alert predates them
    const { api, sent } = fake();
    expect((await notifyPending(pool, api)).sent).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    await pool.collection('telegram_users').updateOne({ _id: 20 as never }, { $set: { subscribed_at: new Date() } });   // they say yes now
    await new Promise((r) => setTimeout(r, 20));
    await addAlert('600002');
    expect((await notifyPending(pool, api)).sent).toBe(1);
    expect(sent[0]!.text).toContain('600,002');
  });

  it('records a failed delivery per person and retries it later without bothering the others', async () => {
    await reset();
    await addUser(30, 'subscribed'); await addUser(31, 'subscribed');
    const id = await addAlert();
    const bad = fake({ error: new TelegramError('Telegram answered 400: chat not found', 400), failFor: '30' });
    const r = await notifyPending(pool, bad.api);
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    expect(bad.sent.map((s) => s.chat)).toEqual(['31']);
    expect(await log(id, 30)).toMatchObject({ status: 'failed', attempts: 1, error: 'Telegram answered 400: chat not found' });
    const good = fake();
    expect((await notifyPending(pool, good.api)).sent).toBe(1);
    expect(good.sent.map((s) => s.chat)).toEqual(['30']);
    expect(await log(id, 30)).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('gives up on a delivery after the maximum number of attempts', async () => {
    await reset();
    await addUser(40, 'subscribed');
    const id = await addAlert();
    const bad = fake({ error: new TelegramError('nope', 400) });
    for (let i = 0; i < 3; i++) await notifyPending(pool, bad.api, { maxAttempts: 3 });
    expect((await log(id, 40))!.attempts).toBe(3);
    const good = fake();
    expect((await notifyPending(pool, good.api, { maxAttempts: 3 })).sent).toBe(0);
  });

  it('moves a person who blocked the bot back to "authorized" (they can opt in again)', async () => {
    await reset();
    await addUser(50, 'subscribed');
    await addAlert();
    const r = await notifyPending(pool, fake({ error: new TelegramError('Telegram answered 403: Forbidden: bot was blocked by the user', 403) }).api);
    expect(r.failed).toBe(1);
    const u = await pool.collection('telegram_users').findOne({ _id: 50 as never });
    expect(u).toMatchObject({ status: 'authorized', subscribed_at: null });
  });

  it('stops the whole run on a rate limit and leaves the rest for the next run', async () => {
    await reset();
    await addUser(60, 'subscribed');
    for (let i = 0; i < 3; i++) await addAlert();
    const r = await notifyPending(pool, fake({ error: new StopRun('Telegram answered 429') }).api);
    expect(r.failed).toBe(1);
    expect(r.skipped).toMatch(/429/);
    expect((await notifyPending(pool, fake().api)).sent).toBe(3);
  });

  it('sends at most maxPerRun messages per person per run, oldest first, and reports how many are waiting', async () => {
    await reset();
    await addUser(70, 'subscribed');
    for (let i = 0; i < 5; i++) await addAlert(String(600000 + i));
    const { api, sent } = fake();
    expect(await notifyPending(pool, api, { maxPerRun: 2 })).toMatchObject({ sent: 2, remaining: 3 });
    expect(sent[0]!.text).toContain('600,000'); expect(sent[1]!.text).toContain('600,001');
    expect((await notifyPending(pool, api, { maxPerRun: 2 })).sent).toBe(2);
    expect((await notifyPending(pool, api, { maxPerRun: 2 })).sent).toBe(1);
    expect(new Set(sent.map((s) => s.text)).size).toBe(5);
  });
});
