// Sends stored alerts to Telegram. It only reads alerts that already exist and writes a log row per alert and channel, so an alert is sent
// once. Everything here is optional: with no bot token and chat id nothing happens, and a delivery failure never affects detection or a sync.
// The bot token is read from the environment only and is never written to a log or an error message.
import type pg from 'pg';
import { getPool } from '@deod/db';
import { loadConfig, loadEnv } from '@deod/config';

export interface Sender { channel: 'telegram'; send(text: string): Promise<void> }

/** A delivery error that makes further attempts in the same run pointless (rate limit, network down). */
export class StopRun extends Error {}

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

/** Telegram Bot API sender. fetchImpl is injectable for tests. */
export function telegramSender(token: string, chatId: string, fetchImpl: typeof fetch = fetch): Sender {
  return {
    channel: 'telegram',
    async send(text) {
      let res: Response;
      try {
        res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
      } catch {
        throw new StopRun('could not reach Telegram');                                   // never include the URL: it contains the token
      }
      if (res.ok) return;
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      const msg = `Telegram answered ${res.status}${body.description ? `: ${body.description}` : ''}`;
      if (res.status === 429 || res.status >= 500) throw new StopRun(msg);
      throw new Error(msg);
    },
  };
}

/** null when Telegram is not configured; throws a clear message when it is configured but the values do not look right. */
export function senderFromEnv(): Sender | null {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = loadEnv();
  if (!token && !chat) return null;
  if (!token || !chat) throw new Error('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in backend/.env (or leave both empty)');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('TELEGRAM_BOT_TOKEN does not look right: it should be like 123456789:AAH... (copy it from BotFather)');
  if (!/^-?\d+$/.test(chat)) throw new Error('TELEGRAM_CHAT_ID must be a number such as 123456789 (see getUpdates)');
  return telegramSender(token, chat);
}

export interface NotifyResult { sent: number; failed: number; remaining: number; skipped: string | null }

/**
 * Sends alerts created since the channel was first switched on and not yet delivered. At most `maxPerRun` messages per run (a burst
 * waits for the next run instead of flooding the chat); a failing alert is retried on later runs up to `maxAttempts` times.
 */
export async function notifyPending(
  db: pg.Pool = getPool(), sender: Sender | null = senderFromEnv(), opts: { maxPerRun?: number; maxAttempts?: number } = {},
): Promise<NotifyResult> {
  if (!sender) return { sent: 0, failed: 0, remaining: 0, skipped: 'Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)' };
  const maxPerRun = opts.maxPerRun ?? 20, maxAttempts = opts.maxAttempts ?? 5;
  const cfg = loadConfig();
  const names = (slug: string) => cfg.exchanges[slug]?.name ?? slug;

  await db.query(`INSERT INTO notification_channels (channel) VALUES ($1) ON CONFLICT DO NOTHING`, [sender.channel]);
  const pending = `FROM alerts a JOIN alert_rules r ON r.code = a.rule_code
     JOIN notification_channels c ON c.channel = $1
     WHERE a.created_at >= c.enabled_at
       AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.alert_id = a.id AND n.channel = $1 AND (n.status = 'sent' OR n.attempts >= $2))`;
  const { rows } = await db.query(
    `SELECT a.id, a.occurred_at, a.exchange, a.direction, a.amount::text AS amount, a.usd_value::text AS usd_value, a.sender, a.recipient, a.wallet_address,
            a.tx_hash, a.block_number, a.details, a.severity, a.rule_code, r.name AS rule_name ${pending} ORDER BY a.occurred_at, a.id LIMIT $3`,
    [sender.channel, maxAttempts, maxPerRun],
  );
  const { rows: [{ n: waiting }] } = await db.query(`SELECT count(*)::int AS n ${pending}`, [sender.channel, maxAttempts]);
  const batch = rows;
  const result: NotifyResult = { sent: 0, failed: 0, remaining: waiting - batch.length, skipped: null };

  for (const a of batch) {
    try {
      await sender.send(formatAlertMessage(a as AlertForMessage, cfg.chain.explorer_tx_url, names));
      await db.query(
        `INSERT INTO notification_log (alert_id, channel, status, sent_at) VALUES ($1, $2, 'sent', now())
         ON CONFLICT (alert_id, channel) DO UPDATE SET status = 'sent', sent_at = now(), last_attempt_at = now(), error = NULL, attempts = notification_log.attempts + 1`,
        [a.id, sender.channel],
      );
      result.sent++;
    } catch (e) {
      const error = (e instanceof Error ? e.message : 'send failed').slice(0, 300);
      await db.query(
        `INSERT INTO notification_log (alert_id, channel, status, error) VALUES ($1, $2, 'failed', $3)
         ON CONFLICT (alert_id, channel) DO UPDATE SET status = 'failed', error = $3, last_attempt_at = now(), attempts = notification_log.attempts + 1`,
        [a.id, sender.channel, error],
      );
      result.failed++;
      if (e instanceof StopRun) { result.remaining += batch.length - result.sent - result.failed; result.skipped = error; break; }
    }
  }
  return result;
}
