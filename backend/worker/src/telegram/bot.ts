// The Telegram bot's conversation. A person must send the access code to be allowed in, and is then asked whether to receive alerts.
// handleUpdate() holds all the rules and takes an injected Telegram client, so it is tested without the network. startTelegramBot() is the
// polling loop that feeds it (getUpdates, because a local or private server has no public address for webhooks).
import { createHash, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { loadConfig, loadEnv } from '@deod/config';
import { formatAlertMessage, type AlertForMessage } from '../alerts/notify.js';
import { TOKEN_SHAPE, TelegramError, telegramApi, type InlineKeyboard, type TelegramApi, type TgCallback, type TgMessage, type TgUpdate } from './api.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 60;
/** Wrong codes accepted from ALL chats together per hour before code checking pauses (stops guessing from many accounts). */
export const GLOBAL_FAILS_PER_HOUR = 30;

export const MIN_ACCESS_CODE_LENGTH = 8;

export interface BotContext {
  db: pg.Pool;
  api: TelegramApi;
  accessCode: string;
  now?: () => Date;
  /** Shared across calls: timestamps (ms) of recent wrong codes, from any chat. */
  recentFails?: number[];
}

const ASK_ALERTS: InlineKeyboard = { inline_keyboard: [[{ text: 'Yes, send me alerts', callback_data: 'sub:yes' }, { text: 'Not now', callback_data: 'sub:no' }]] };

const T = {
  needCode: 'DEODScan alerts is a private bot.\nPlease send your access code to continue.',
  invalid: 'That access code is not valid.',
  paused: 'Too many wrong codes were tried. Please try again later.',
  askAlerts: 'Access granted. Welcome to DEODScan.\n\nDo you want to receive DEOD alerts here? You will get a message when a large transfer or swap, an unusual exchange flow or activity of a watched wallet is detected. You can stop at any time with /stop.',
  subscribed: 'Done. You will now get DEOD alerts here.\n\nAlerts cover recorded transactions only (monitored exchange addresses and the PancakeSwap pools) and arrive after each daily sync, so they are not real time.\n\n/latest shows the most recent alerts, /stop turns alerts off.',
  declined: 'No problem, alerts are off. Send /subscribe whenever you want them.',
  stopped: 'Alerts are off. Send /subscribe to turn them on again.',
  help: '/subscribe: receive alerts\n/stop: stop alerts\n/latest: the 5 most recent alerts\n/status: your current setting',
  unknown: 'I did not understand that. Send /help to see what I can do.',
  codeFirst: 'Please send your access code first.',
};

const sha = (s: string) => createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

interface UserRow { chat_id: string; status: 'new' | 'authorized' | 'subscribed' | 'blocked'; failed_attempts: number; locked_until: Date | null }

async function loadUser(ctx: BotContext, chatId: number, from?: { username?: string; first_name?: string }): Promise<UserRow> {
  const { rows } = await ctx.db.query(
    `INSERT INTO telegram_users (chat_id, username, first_name) VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET username = COALESCE($2, telegram_users.username), first_name = COALESCE($3, telegram_users.first_name), updated_at = now()
     RETURNING chat_id::text AS chat_id, status, failed_attempts, locked_until`,
    [chatId, from?.username ?? null, from?.first_name ?? null],
  );
  return rows[0] as UserRow;
}

const setStatus = (ctx: BotContext, chatId: number, status: string, extra = '') =>
  ctx.db.query(`UPDATE telegram_users SET status = $2, updated_at = now() ${extra} WHERE chat_id = $1`, [chatId, status]);

async function latestAlerts(ctx: BotContext): Promise<string[]> {
  const cfg = loadConfig();
  const { rows } = await ctx.db.query(
    `SELECT a.occurred_at, a.exchange, a.direction, a.amount::text AS amount, a.usd_value::text AS usd_value, a.sender, a.recipient, a.wallet_address, a.tx_hash,
            a.block_number, a.details, a.severity, a.rule_code, r.name AS rule_name
     FROM alerts a JOIN alert_rules r ON r.code = a.rule_code ORDER BY a.occurred_at DESC, a.id DESC LIMIT 5`);
  return rows.map((a) => formatAlertMessage(a as AlertForMessage, cfg.chain.explorer_tx_url, (s) => cfg.exchanges[s]?.name ?? s));
}

/** Checks a message that was sent while the person has not yet been let in. */
async function attemptCode(ctx: BotContext, msg: TgMessage, user: UserRow, text: string, now: Date) {
  const chatId = msg.chat.id;
  if (user.locked_until && user.locked_until > now) {
    const min = Math.ceil((user.locked_until.getTime() - now.getTime()) / 60_000);
    return ctx.api.sendMessage(chatId, `Too many wrong codes. Please try again in ${min} min.`);
  }
  const fails = (ctx.recentFails ??= []).filter((t) => now.getTime() - t < 3_600_000);
  ctx.recentFails = fails;
  if (fails.length >= GLOBAL_FAILS_PER_HOUR) return ctx.api.sendMessage(chatId, T.paused);

  if (safeEqual(text, ctx.accessCode)) {
    await setStatus(ctx, chatId, 'authorized', ', failed_attempts = 0, locked_until = NULL, authorized_at = now()');
    await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});             // best effort: remove the code from the chat
    return ctx.api.sendMessage(chatId, T.askAlerts, ASK_ALERTS);
  }
  fails.push(now.getTime());
  const attempts = user.failed_attempts + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    await ctx.db.query(`UPDATE telegram_users SET failed_attempts = 0, locked_until = $2, updated_at = now() WHERE chat_id = $1`, [chatId, new Date(now.getTime() + LOCK_MINUTES * 60_000)]);
    return ctx.api.sendMessage(chatId, `${T.invalid} Too many wrong codes: please try again in ${LOCK_MINUTES} min.`);
  }
  await ctx.db.query(`UPDATE telegram_users SET failed_attempts = $2, updated_at = now() WHERE chat_id = $1`, [chatId, attempts]);
  return ctx.api.sendMessage(chatId, T.invalid);
}

async function subscribe(ctx: BotContext, chatId: number, user: UserRow) {
  if (user.status !== 'subscribed') await setStatus(ctx, chatId, 'subscribed', ', subscribed_at = now()');
  return ctx.api.sendMessage(chatId, T.subscribed);
}

async function onMessage(ctx: BotContext, msg: TgMessage) {
  if (msg.chat.type !== 'private') return;                                            // the bot talks to individuals only, never in groups
  const now = (ctx.now ?? (() => new Date()))();
  const user = await loadUser(ctx, msg.chat.id, msg.from);
  if (user.status === 'blocked') return;                                              // revoked by the owner: no answer, no information
  const chatId = msg.chat.id;
  const text = (msg.text ?? '').trim();
  const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0]!.toLowerCase() : null;

  if (user.status === 'new') {
    if (!text || cmd === '/start' || cmd === '/help') return ctx.api.sendMessage(chatId, T.needCode);
    return attemptCode(ctx, msg, user, text, now);
  }
  switch (cmd) {
    case '/start':
    case '/subscribe':
      if (user.status === 'subscribed') return ctx.api.sendMessage(chatId, 'You are already receiving alerts. /stop turns them off.');
      return ctx.api.sendMessage(chatId, T.askAlerts, ASK_ALERTS);
    case '/stop':
      if (user.status === 'subscribed') await setStatus(ctx, chatId, 'authorized', ', subscribed_at = NULL');
      return ctx.api.sendMessage(chatId, T.stopped);
    case '/status':
      return ctx.api.sendMessage(chatId, user.status === 'subscribed' ? 'Alerts are ON for this chat. /stop turns them off.' : 'Alerts are OFF for this chat. /subscribe turns them on.');
    case '/latest': {
      const msgs = await latestAlerts(ctx);
      if (!msgs.length) return ctx.api.sendMessage(chatId, 'No alerts have been raised yet.');
      for (const m of msgs.reverse()) await ctx.api.sendMessage(chatId, m);
      return;
    }
    case '/help':
      return ctx.api.sendMessage(chatId, T.help);
    default:
      return ctx.api.sendMessage(chatId, T.unknown);
  }
}

async function onCallback(ctx: BotContext, cb: TgCallback) {
  const chat = cb.message?.chat;
  if (!chat || chat.type !== 'private' || (cb.data !== 'sub:yes' && cb.data !== 'sub:no')) return ctx.api.answerCallbackQuery(cb.id).catch(() => {});
  const user = await loadUser(ctx, chat.id, cb.from);
  if (user.status === 'blocked') return;
  if (user.status === 'new') { await ctx.api.answerCallbackQuery(cb.id, T.codeFirst).catch(() => {}); return ctx.api.sendMessage(chat.id, T.needCode); }
  await ctx.api.answerCallbackQuery(cb.id).catch(() => {});
  if (cb.data === 'sub:yes') return subscribe(ctx, chat.id, user);
  return ctx.api.sendMessage(chat.id, user.status === 'subscribed' ? 'Alerts stay on. Send /stop to turn them off.' : T.declined);
}

/** Handles one Telegram update. Never throws for a normal user mistake; Telegram or database failures propagate to the caller. */
export async function handleUpdate(ctx: BotContext, u: TgUpdate): Promise<void> {
  if (u.message) return onMessage(ctx, u.message);
  if (u.callback_query) return onCallback(ctx, u.callback_query);
}

// ---------------------------------------------------------------------------------------------------------------------------------

export interface BotLogger { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void }
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

/** Long-polls Telegram and feeds every update to handleUpdate. Returns a handle whose stop() ends the loop promptly. */
export function startTelegramBot(db: pg.Pool, api: TelegramApi, accessCode: string, log: BotLogger) {
  const stopper = new AbortController();
  const ctx: BotContext = { db, api, accessCode, recentFails: [] };
  let offset: number | undefined;
  let warnedConflict = false;

  const loop = (async () => {
    let backoff = 2000;
    while (!stopper.signal.aborted) {
      try {
        const updates = await api.getUpdates(offset, 25, stopper.signal);
        backoff = 2000; warnedConflict = false;
        for (const u of updates) {
          offset = u.update_id + 1;
          try { await handleUpdate(ctx, u); } catch (e) {
            log.error({ err: e instanceof Error ? e.message : String(e) }, 'telegram bot: could not handle a message');
          }
        }
      } catch (e) {
        if (stopper.signal.aborted) break;
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof TelegramError && e.status === 409) {                         // another copy of the backend is polling this same bot
          if (!warnedConflict) log.warn({}, 'telegram bot: another process is already reading this bot\'s messages; waiting');
          warnedConflict = true;
          await sleep(30_000, stopper.signal);
        } else if (e instanceof TelegramError && e.status === 401) {
          log.error({}, 'telegram bot: Telegram rejected the bot token; the bot is switched off until TELEGRAM_BOT_TOKEN is fixed and the backend restarted');
          break;
        } else {
          log.warn({ err: message }, 'telegram bot: could not reach Telegram; retrying');
          await sleep(backoff, stopper.signal);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    }
  })();

  return { async stop() { stopper.abort(); await loop; } };
}


/**
 * Starts the bot from backend/.env (TELEGRAM_BOT_TOKEN and TELEGRAM_ACCESS_CODE). Returns null, with a plain explanation in the log, when it is
 * not configured or a value is wrong: a mistake here can only switch the bot off, never stop the backend from starting.
 */
export function startBotFromEnv(db: pg.Pool, log: BotLogger) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ACCESS_CODE: code } = loadEnv();
  if (!token) return null;
  if (!TOKEN_SHAPE.test(token)) { log.warn({}, 'telegram bot is off: TELEGRAM_BOT_TOKEN does not look right (it should be like 123456789:AAH...)'); return null; }
  if (!code || code.length < MIN_ACCESS_CODE_LENGTH) {
    log.warn({}, `telegram bot is off: set TELEGRAM_ACCESS_CODE in backend/.env (at least ${MIN_ACCESS_CODE_LENGTH} characters). People must send it to the bot to be let in`);
    return null;
  }
  const bot = startTelegramBot(db, telegramApi(token), code, log);
  log.info({}, 'telegram bot is on: people who send the access code can subscribe to alerts');
  return bot;
}
