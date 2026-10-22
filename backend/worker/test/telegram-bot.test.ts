// The bot's conversation: access code -> permission for alerts -> alerts. Runs against a THROWAWAY database with a fake Telegram, so nothing
// real is sent and deod_monitor is never touched. Skipped (and reported as skipped) when no database server is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '@deod/config';
import { migrate } from '@deod/db';
import { GLOBAL_FAILS_PER_HOUR, LOCK_MINUTES, MAX_FAILED_ATTEMPTS, handleUpdate, type BotContext } from '../src/telegram/bot.js';
import type { InlineKeyboard, TelegramApi, TgUpdate } from '../src/telegram/api.js';
import { syncAlertRules } from '../src/alerts/scan.js';

const CODE = 'correct-horse-battery';

let admin: pg.Client | null = null;
let baseUrl = '';
try {
  baseUrl = loadEnv().DATABASE_URL;
  admin = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
} catch {
  admin = null;
}

describe.skipIf(!admin)('telegram bot conversation', () => {
  const dbName = `deod_bot_test_${Date.now()}`;
  let pool: pg.Pool;
  let uid = 0;

  interface Out { chat: string; text: string; markup?: InlineKeyboard }
  let out: Out[] = [], deleted: string[] = [], answered: (string | undefined)[] = [];
  let clock = new Date('2026-10-22T12:00:00Z');
  const api = {
    sendMessage: async (chat: number | string, text: string, markup?: InlineKeyboard) => { out.push({ chat: String(chat), text, markup }); },
    deleteMessage: async (chat: number | string, id: number) => { deleted.push(`${chat}:${id}`); },
    answerCallbackQuery: async (_id: string, text?: string) => { answered.push(text); },
  } as unknown as TelegramApi;
  let ctx: BotContext;

  const say = (chat: number, text: string, type = 'private') =>
    handleUpdate(ctx, { update_id: ++uid, message: { message_id: uid, chat: { id: chat, type }, from: { username: `user${chat}`, first_name: `U${chat}` }, text } } as TgUpdate);
  const press = (chat: number, data: string) =>
    handleUpdate(ctx, { update_id: ++uid, callback_query: { id: `cb${uid}`, data, from: { id: chat }, message: { message_id: 1, chat: { id: chat, type: 'private' } } } } as TgUpdate);
  const user = async (chat: number) => (await pool.query(`SELECT status, failed_attempts, locked_until, subscribed_at, authorized_at, username FROM telegram_users WHERE chat_id = $1`, [chat])).rows[0];
  const last = () => out[out.length - 1]!;
  const clear = () => { out = []; deleted = []; answered = []; ctx.recentFails = []; clock = new Date('2026-10-22T12:00:00Z'); };

  beforeAll(async () => {
    await admin!.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${dbName}`), max: 4 });
    await migrate(pool);
    await syncAlertRules(pool);
    ctx = { db: pool, api, accessCode: CODE, now: () => clock, recentFails: [] };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('asks a stranger for the access code and gives nothing away', async () => {
    clear();
    await say(1, '/start');
    expect(last().text).toContain('private bot');
    expect(last().text).toContain('access code');
    expect((await user(1)).status).toBe('new');
    expect(last().markup).toBeUndefined();
  });

  it('rejects a wrong code, counts it, and never answers commands or questions before the code is right', async () => {
    clear();
    await say(2, '/latest');
    expect(last().text).toBe('That access code is not valid.');
    await say(2, 'hello?');
    expect(last().text).toBe('That access code is not valid.');
    expect((await user(2))).toMatchObject({ status: 'new', failed_attempts: 2 });
    expect(out.every((o) => !/alert/i.test(o.text.replace('access code', '')) || o.text.includes('not valid'))).toBe(true);
  });

  it('is case and character exact, and ignores surrounding spaces', async () => {
    clear();
    await say(3, CODE.toUpperCase());
    expect(last().text).toContain('not valid');
    await say(3, `${CODE}x`);
    expect(last().text).toContain('not valid');
    await say(3, `  ${CODE}  `);
    expect((await user(3)).status).toBe('authorized');
  });

  it('accepts the right code, removes it from the chat, and then asks permission to send alerts', async () => {
    clear();
    await say(4, CODE);
    expect(await user(4)).toMatchObject({ status: 'authorized', failed_attempts: 0 });
    expect((await user(4)).authorized_at).toBeInstanceOf(Date);
    expect(deleted).toEqual([`4:${uid}`]);
    expect(last().text).toContain('Access granted');
    expect(last().text).toContain('Do you want to receive DEOD alerts');
    expect(last().markup!.inline_keyboard[0]!.map((b) => b.callback_data)).toEqual(['sub:yes', 'sub:no']);
    expect(out.some((o) => o.text.includes(CODE))).toBe(false);                       // the code is never repeated back
  });

  it('turns alerts on only when the person says yes, and records when', async () => {
    clear();
    await say(5, CODE);
    await press(5, 'sub:no');
    expect((await user(5)).status).toBe('authorized');
    expect(last().text).toContain('alerts are off');
    await press(5, 'sub:yes');
    const u = await user(5);
    expect(u.status).toBe('subscribed');
    expect(u.subscribed_at).toBeInstanceOf(Date);
    expect(last().text).toContain('You will now get DEOD alerts');
    const first = u.subscribed_at.getTime();
    await press(5, 'sub:yes');                                                          // pressing twice changes nothing
    expect((await user(5)).subscribed_at.getTime()).toBe(first);
  });

  it('does not let someone skip the code by pressing the buttons', async () => {
    clear();
    await say(6, '/start');
    await press(6, 'sub:yes');
    expect((await user(6)).status).toBe('new');
    expect(answered.some((t) => t?.includes('access code'))).toBe(true);
    expect(last().text).toContain('access code');
  });

  it('locks a chat after too many wrong codes, even for the right code, until the lock ends', async () => {
    clear();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await say(7, `wrong-${i}`);
    expect(last().text).toContain(`${LOCK_MINUTES} min`);
    await say(7, CODE);
    expect(last().text).toContain('Too many wrong codes');
    expect((await user(7)).status).toBe('new');
    clock = new Date(clock.getTime() + (LOCK_MINUTES + 1) * 60_000);
    await say(7, CODE);
    expect((await user(7)).status).toBe('authorized');
  });

  it('pauses code checking for everyone after too many wrong codes from many chats', async () => {
    clear();
    for (let i = 0; i < GLOBAL_FAILS_PER_HOUR; i++) await say(1000 + i, 'guess');
    await say(2000, CODE);                                                              // even the right code waits
    expect(last().text).toContain('Too many wrong codes were tried');
    expect((await user(2000)).status).toBe('new');
    clock = new Date(clock.getTime() + 61 * 60_000);
    await say(2000, CODE);
    expect((await user(2000)).status).toBe('authorized');
  });

  it('lets an allowed person stop, restart and check their status', async () => {
    clear();
    await say(8, CODE); await press(8, 'sub:yes');
    await say(8, '/status');
    expect(last().text).toContain('ON');
    await say(8, '/stop');
    expect((await user(8))).toMatchObject({ status: 'authorized', subscribed_at: null });
    await say(8, '/status');
    expect(last().text).toContain('OFF');
    await say(8, '/subscribe');
    expect(last().markup!.inline_keyboard[0]![0]!.callback_data).toBe('sub:yes');   // asks again, does not switch on by itself
    expect((await user(8)).status).toBe('authorized');
    await say(8, '/nonsense');
    expect(last().text).toContain('use the buttons');
  });

  const labels = (o: Out) => o.markup!.inline_keyboard.flat().map((b) => b.text);

  it('offers buttons instead of commands: a menu with Latest alerts, Status and the alerts switch', async () => {
    clear();
    await say(11, CODE); await press(11, 'sub:yes');
    expect(labels(last())).toEqual(['Latest alerts', 'Status', 'Turn alerts off']);       // right after saying yes
    await say(11, '/start');
    expect(last().text).toBe('What would you like to do?');
    expect(labels(last())).toEqual(['Latest alerts', 'Status', 'Turn alerts off']);
    await say(11, 'hello');                                                              // free text is answered with the menu, not an error
    expect(last().text).toContain('use the buttons');
    expect(last().markup).toBeDefined();
  });

  it('the Status button reports the current setting and the menu follows it', async () => {
    clear();
    await say(12, CODE); await press(12, 'sub:yes');
    await press(12, 'menu:status');
    expect(last().text).toBe('Alerts are ON for this chat.');
    await press(12, 'sub:off');
    expect(last().text).toContain('Alerts are off');
    expect(labels(last())).toEqual(['Latest alerts', 'Status', 'Turn alerts on']);
    expect((await user(12))).toMatchObject({ status: 'authorized', subscribed_at: null });
    await press(12, 'menu:status');
    expect(last().text).toBe('Alerts are OFF for this chat.');
    await press(12, 'sub:yes');                                                          // the toggle turns them back on
    expect((await user(12)).status).toBe('subscribed');
  });

  it('the Latest alerts button shows recent alerts with the menu under the last one', async () => {
    clear();
    await pool.query(
      `INSERT INTO alerts (dedup_key, rule_code, severity, source, occurred_at, exchange, direction, amount, sender, recipient, tx_hash, evt_index, block_number)
       VALUES ('x:menu', 'large_transfer', 'high', 'exchange_flow', now(), 'mexc', 'IN', 650000, '0x1ffbdf86dcd09980ee8e2e89a301c5e15f2d49c7', '0x4982085c9e2f89f2ecb8131eca71afad896e89cb', $1, 1, 6)`, [`0x${'ef'.repeat(32)}`]);
    await say(13, CODE); await press(13, 'sub:yes');
    out.length = 0;
    await press(13, 'menu:latest');
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((o) => o.text.includes('Amount: 650,000 DEOD'))).toBe(true);
    expect(out.slice(0, -1).every((o) => o.markup === undefined)).toBe(true);           // only the last message carries the menu
    expect(labels(last())).toEqual(['Latest alerts', 'Status', 'Turn alerts off']);
  });

  it('menu buttons do nothing for someone who has not entered the code, and unknown buttons are ignored', async () => {
    clear();
    await say(14, '/start');
    out.length = 0;
    await press(14, 'menu:latest');
    expect(out.map((o) => o.text)).toEqual(['DEODScan alerts is a private bot.\nPlease send your access code to continue.']);
    expect((await user(14)).status).toBe('new');
    await say(15, CODE);
    out.length = 0;
    await press(15, 'something:else');
    expect(out).toHaveLength(0);
  });

  it('shows the latest alerts only to people who were let in', async () => {
    clear();
    await pool.query(
      `INSERT INTO alerts (dedup_key, rule_code, severity, source, occurred_at, exchange, direction, amount, sender, recipient, tx_hash, evt_index, block_number)
       VALUES ('x:1', 'large_transfer', 'high', 'exchange_flow', now(), 'mexc', 'IN', 600000, '0x1ffbdf86dcd09980ee8e2e89a301c5e15f2d49c7', '0x4982085c9e2f89f2ecb8131eca71afad896e89cb', $1, 1, 5)`, [`0x${'cd'.repeat(32)}`]);
    await say(9, '/latest');                                                            // not let in: treated as a (wrong) code
    expect(out.some((o) => o.text.includes('600,000'))).toBe(false);
    await say(9, CODE);
    out.length = 0;
    await say(9, '/latest');
    expect(out.length).toBeGreaterThanOrEqual(1);
    const mine = out.find((o) => o.text.includes('Amount: 600,000 DEOD'));
    expect(mine).toBeDefined();
    expect(mine!.text).toContain('https://bscscan.com/tx/0x' + 'cd'.repeat(32));
  });

  it('ignores groups completely', async () => {
    clear();
    await say(-100500, '/start', 'supergroup');
    await say(-100500, CODE, 'group');
    expect(out).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM telegram_users WHERE chat_id = -100500`)).rows[0].n).toBe(0);
  });

  it('stays silent to a revoked person, even with the right code', async () => {
    clear();
    await say(10, CODE);
    await pool.query(`UPDATE telegram_users SET status = 'blocked' WHERE chat_id = 10`);
    out.length = 0;
    await say(10, CODE); await say(10, '/start'); await press(10, 'sub:yes');
    expect(out).toHaveLength(0);
    expect((await user(10)).status).toBe('blocked');
  });
});
