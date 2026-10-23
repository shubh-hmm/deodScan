// Sends stored alerts to every Telegram user who has been allowed in (entered the access code) AND said yes to alerts. It only reads alerts that
// already exist and writes one log row per alert and person, so nobody gets the same alert twice. Everything here is optional: with no bot
// configured nothing happens, and a delivery failure never affects detection or a sync.
import type { Db, Document } from 'mongodb';
import { decStr, decStrOrNull, getDb, nextIds } from '@deod/db';
import { loadConfig, loadEnv } from '@deod/config';
import { StopRun, TOKEN_SHAPE, TelegramError, telegramApi, type TelegramApi } from '../telegram/api.js';

export { StopRun };

export interface AlertForMessage {
  rule_name: string; severity: string; rule_code: string; occurred_at: Date; exchange: string | null; direction: string | null; amount: string;
  usd_value: string | null; sender: string | null; recipient: string | null; wallet_address: string | null; tx_hash: string | null;
  block_number: number | null; details: Record<string, unknown>;
}

/** A stored alert (database document) plus its rule's name, in the shape formatAlertMessage() takes. */
export function toAlertForMessage(a: Document, ruleName: string): AlertForMessage {
  return {
    rule_name: ruleName, severity: a.severity, rule_code: a.rule_code, occurred_at: a.occurred_at, exchange: a.exchange ?? null, direction: a.direction ?? null,
    amount: decStr(a.amount), usd_value: decStrOrNull(a.usd_value), sender: a.sender ?? null, recipient: a.recipient ?? null, wallet_address: a.wallet_address ?? null,
    tx_hash: a.tx_hash ?? null, block_number: a.block_number ?? null, details: a.details ?? {},
  };
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
  db: Db = getDb(), api: TelegramApi | null = apiFromEnv(), opts: { maxPerRun?: number; maxAttempts?: number } = {},
): Promise<NotifyResult> {
  const result: NotifyResult = { sent: 0, failed: 0, remaining: 0, recipients: 0, skipped: null };
  if (!api) { result.skipped = 'Telegram is not configured (TELEGRAM_BOT_TOKEN)'; return result; }
  const maxPerRun = opts.maxPerRun ?? 20, maxAttempts = opts.maxAttempts ?? 5;
  const cfg = loadConfig();
  const names = (slug: string) => cfg.exchanges[slug]?.name ?? slug;
  const log = db.collection('notification_log');

  const users = await db.collection('telegram_users').find({ status: 'subscribed' }).sort({ _id: 1 }).toArray();
  result.recipients = users.length;
  const ruleNames = new Map((await db.collection('alert_rules').find().toArray()).map((r) => [r._id as unknown as string, r.name as string]));
  for (const u of users) {
    const chatId = String(u._id);
    // Alerts created since this person subscribed that have not been delivered to them (sent, or given up after maxAttempts).
    const [page] = await db.collection('alerts').aggregate([
      { $match: { created_at: { $gte: u.subscribed_at } } },
      {
        $lookup: {
          from: 'notification_log', as: 'done', let: { id: '$_id' },
          pipeline: [{ $match: { $expr: { $and: [
            { $eq: ['$alert_id', '$$id'] }, { $eq: ['$channel', 'telegram'] }, { $eq: ['$recipient', chatId] },
            { $or: [{ $eq: ['$status', 'sent'] }, { $gte: ['$attempts', maxAttempts] }] },
          ] } } }, { $limit: 1 }],
        },
      },
      { $match: { done: { $size: 0 } } },
      { $sort: { occurred_at: 1, _id: 1 } },
      { $facet: { rows: [{ $limit: maxPerRun }], n: [{ $count: 'n' }] } },
    ]).toArray();
    const rows = (page?.rows ?? []) as Document[];
    const waiting = (page?.n?.[0]?.n as number | undefined) ?? 0;
    result.remaining += waiting - rows.length;

    const key = (alertId: number) => ({ alert_id: alertId, channel: 'telegram', recipient: chatId });
    for (const a of rows) {
      const alertId = a._id as unknown as number;
      try {
        await api.sendMessage(chatId, formatAlertMessage(toAlertForMessage(a, ruleNames.get(a.rule_code) ?? a.rule_code), cfg.chain.explorer_tx_url, names));
        await log.updateOne(key(alertId), {
          $set: { status: 'sent', sent_at: new Date(), last_attempt_at: new Date(), error: null }, $inc: { attempts: 1 }, $setOnInsert: { _id: (await nextIds(db, 'notification_log')) as never },
        }, { upsert: true });
        result.sent++;
      } catch (e) {
        const error = (e instanceof Error ? e.message : 'send failed').slice(0, 300);
        await log.updateOne(key(alertId), {
          $set: { status: 'failed', error, last_attempt_at: new Date() }, $inc: { attempts: 1 }, $setOnInsert: { _id: (await nextIds(db, 'notification_log')) as never, sent_at: null },
        }, { upsert: true });
        result.failed++;
        if (e instanceof StopRun) { result.skipped = error; return result; }
        if (e instanceof TelegramError && e.botBlocked) {
          await db.collection('telegram_users').updateOne({ _id: u._id }, { $set: { status: 'authorized', subscribed_at: null, updated_at: new Date() } });
          break;                                                                       // nothing more can be delivered to this person
        }
      }
    }
  }
  return result;
}
