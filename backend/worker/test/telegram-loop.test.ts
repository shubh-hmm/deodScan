import { describe, expect, it } from 'vitest';
import { startTelegramBot, type BotLogger } from '../src/telegram/bot.js';
import { TelegramError, type TelegramApi } from '../src/telegram/api.js';

const logs: { level: string; msg: string }[] = [];
const log: BotLogger = { info: (_o, msg) => logs.push({ level: 'info', msg }), warn: (_o, msg) => logs.push({ level: 'warn', msg }), error: (_o, msg) => logs.push({ level: 'error', msg }) };
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
// A group message is ignored before any database access, so the loop can be tested without a database.
const groupMsg = (id: number) => ({ update_id: id, message: { message_id: 1, chat: { id: -5, type: 'group' }, text: 'hi' } });

describe('telegram polling loop', () => {
  it('moves past each handled update and stops promptly while waiting for the next one', async () => {
    const offsets: (number | undefined)[] = [];
    const api = {
      getUpdates: async (offset: number | undefined, _t: number, signal?: AbortSignal) => {
        offsets.push(offset);
        if (offsets.length === 1) return [groupMsg(41), groupMsg(42)];
        await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))));
        return [];
      },
    } as unknown as TelegramApi;
    const bot = startTelegramBot({} as never, api, 'code-12345', log);
    await until(() => offsets.length >= 2);
    expect(offsets).toEqual([undefined, 43]);
    const t = Date.now();
    await bot.stop();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('switches itself off, with a clear message, when Telegram rejects the token', async () => {
    logs.length = 0;
    let calls = 0;
    const api = { getUpdates: async () => { calls++; throw new TelegramError('Telegram answered 401: Unauthorized', 401); } } as unknown as TelegramApi;
    const bot = startTelegramBot({} as never, api, 'code-12345', log);
    await until(() => logs.some((l) => l.level === 'error'));
    await bot.stop();
    expect(calls).toBe(1);                                                              // it did not keep retrying with a bad token
    expect(logs.some((l) => l.level === 'error' && /rejected the bot token/.test(l.msg))).toBe(true);
  });
});
