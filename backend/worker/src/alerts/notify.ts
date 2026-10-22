// Sends stored alerts to every Telegram user who has been allowed in (entered the access code) AND said yes to alerts. It only reads alerts that
// already exist and writes one log row per alert and person, so nobody gets the same alert twice. Everything here is optional: with no bot
// configured nothing happens, and a delivery failure never affects detection or a sync.
import type pg from 'pg';
import { getPool } from '@deod/db';
import { loadConfig, loadEnv } from '@deod/config';
import { StopRun, TOKEN_SHAPE, TelegramError, telegramApi, type TelegramApi } from '../telegram/api.js';

export { StopRun };

export interface AlertForMessage {
  rule_name: string; severity: string; rule_code: string; occurred_at: Date; exchange: string | null; direction: string | null; amount: string;
  usd_value: string | null; sender: string | null; recipient: string | null; wallet_address: string | null; tx_hash: string | null;
  block_number: number | null; details: Record<string, unknown>;
}

const deod = (v: string) => {
  const [i, f = ''] = v.split('.');
  const frac = f.replace(/0+$/, '').slice(0, 4);
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
};
const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Plain text (no markup to escape). Only stored facts: no guesses about who a wallet is. */
export function formatAlertMessage(a: AlertForMessage, explorerTxUrl: string, exchangeName: (slug: string) => string = (s) => s): string {
  const lines: string[] = [`DEODScan alert: ${a.rule_name} (${a.severity})`];
  const venue = a.exchange ? exchangeName(a.exchange) : a.rule_code === 'large_swap' || a.direction === 'BUY' || a.direction === 'SELL' ? 'PancakeSwap' : null;
  lines.push(`Amount: ${deod(a.amount)} DEOD${a.usd_value ? ` (about $${Number(a.usd_value).toFixed(2)})` : ''}`);
  if (venue || a.direction) lines.push(`${venue ?? ''}${venue && a.direction ? ' · ' : ''}${a.direction ?? ''}`.trim());
  if (a.tx_hash) {
    lines.push(`From: ${a.sender ?? 'unknown'}`, `To: ${a.recipient ?? 'unknown'}`, `Time: ${when(a.occurred_at)}`, `Tx: ${a.tx_hash}`, `${explorerTxUrl}${a.tx_hash}`);
  } else {
    const d = a.details;
    lines.push(`Day: ${String(d.day ?? when(a.occurred_at).slice(0, 10))} (UTC, finished day total)`);
    lines.push(d.ratio ? `${d.ratio}x its ${d.tracked_days}-day daily average of ${deod(String(d.baseline_mean))} DEOD` : `Active after ${d.tracked_days} quiet days`);
  }
  if (a.wallet_address && a.rule_code === 'watched_wallet') lines.push(`Watched wallet: ${a.wallet_address}`);
  return lines.join('\n');
}

/** null when no bot token is set; throws a clear message when it is set but does not look like a token. */
export function apiFromEnv(): TelegramApi | null {
  const token = loadEnv().TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (!TOKEN_SHAPE.test(token)) throw new Error('TELEGRAM_BOT_TOKEN does not look right: it should be like 123456789:AAH... (copy it from BotFather)');
  return telegramApi(token);
}

export interface NotifyResult { sent: number; failed: number; remaining: number; recipients: number; skipped: string | null }

/**
 * For each subscribed person: sends the alerts created since they subscribed and not yet delivered to them. At most `maxPerRun` messages per
 * person per run (a burst continues on the next run instead of flooding a chat); a failing delivery is retried on later runs up to
 * `maxAttempts` times. A person who blocked the bot is moved back to "authorized" (they can switch alerts on again). A rate limit or an outage
 * stops the whole run.
 */
export async function notifyPending(
  db: pg.Pool = getPool(), api: TelegramApi | null = apiFromEnv(), opts: { maxPerRun?: number; maxAttempts?: number } = {},
): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, failed: 0, remaining: 0, recipients: 0, skipped: null };
  if (!api) { result.skipped = 'Telegram is not configured (TELEGRAM_BOT_TOKEN)'; return result; }
  const maxPerRun = opts.maxPerRun ?? 20, maxAttempts = opts.maxAttempts ?? 5;
  const cfg = loadConfig();
  const names = (slug: string) => cfg.exchanges[slug]?.name ?? slug;

  const { rows: users } = await db.query(`SELECT chat_id::text AS chat_id, subscribed_at FROM telegram_users WHERE status = 'subscribed' ORDER BY chat_id`);
  result.recipients = users.length;
  for (const u of users) {
    const pending = `FROM alerts a JOIN alert_rules r ON r.code = a.rule_code
       WHERE a.created_at >= $1
         AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.alert_id = a.id AND n.channel = 'telegram' AND n.recipient = $2 AND (n.status = 'sent' OR n.attempts >= $3))`;
    const { rows } = await db.query(
      `SELECT a.id, a.occurred_at, a.exchange, a.direction, a.amount::text AS amount, a.usd_value::text AS usd_value, a.sender, a.recipient, a.wallet_address,
              a.tx_hash, a.block_number, a.details, a.severity, a.rule_code, r.name AS rule_name ${pending} ORDER BY a.occurred_at, a.id LIMIT $4`,
      [u.subscribed_at, u.chat_id, maxAttempts, maxPerRun],
    );
    const { rows: [{ n: waiting }] } = await db.query(`SELECT count(*)::int AS n ${pending}`, [u.subscribed_at, u.chat_id, maxAttempts]);
    result.remaining += waiting - rows.length;

    for (const a of rows) {
      try {
        await api.sendMessage(u.chat_id, formatAlertMessage(a as AlertForMessage, cfg.chain.explorer_tx_url, names));
        await db.query(
          `INSERT INTO notification_log (alert_id, channel, recipient, status, sent_at) VALUES ($1, 'telegram', $2, 'sent', now())
           ON CONFLICT (alert_id, channel, recipient) DO UPDATE SET status = 'sent', sent_at = now(), last_attempt_at = now(), error = NULL, attempts = notification_log.attempts + 1`,
          [a.id, u.chat_id],
        );
        result.sent++;
      } catch (e) {
        const error = (e instanceof Error ? e.message : 'send failed').slice(0, 300);
        await db.query(
          `INSERT INTO notification_log (alert_id, channel, recipient, status, error) VALUES ($1, 'telegram', $2, 'failed', $3)
           ON CONFLICT (alert_id, channel, recipient) DO UPDATE SET status = 'failed', error = $3, last_attempt_at = now(), attempts = notification_log.attempts + 1`,
          [a.id, u.chat_id, error],
        );
        result.failed++;
        if (e instanceof StopRun) { result.skipped = error; return result; }
        if (e instanceof TelegramError && e.botBlocked) {
          await db.query(`UPDATE telegram_users SET status = 'authorized', subscribed_at = NULL, updated_at = now() WHERE chat_id = $1`, [u.chat_id]);
          break;                                                                       // nothing more can be delivered to this person
        }
      }
    }
  }
  return result;
}
