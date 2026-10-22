// Minimal Telegram Bot API client (plain fetch, no extra package). The bot token is only ever placed in the request address and never in an
// error message, a log line or a return value. fetch is injectable so tests never touch the network.

/** A failure that makes further calls in the same run pointless: rate limit, Telegram or network down. */
export class StopRun extends Error {}

/** Telegram refused one specific call (bad chat, blocked bot, ...). */
export class TelegramError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
  get botBlocked() { return this.status === 403; }   // the user blocked the bot or deleted the chat
}

export interface TgMessage { message_id: number; chat: { id: number; type: string }; from?: { username?: string; first_name?: string }; text?: string }
export interface TgCallback { id: string; data?: string; from: { id: number; username?: string; first_name?: string }; message?: { message_id: number; chat: { id: number; type: string } } }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }
export interface InlineKeyboard { inline_keyboard: { text: string; callback_data: string }[][] }

export interface TelegramApi {
  getMe(): Promise<{ username: string }>;
  getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number | string, text: string, replyMarkup?: InlineKeyboard): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  deleteMessage(chatId: number | string, messageId: number): Promise<void>;
}

export const TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]{20,}$/;

export function telegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  async function call<T>(method: string, body: object, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (signal?.aborted) throw e;                                                    // a deliberate stop, not a failure
      throw new StopRun('could not reach Telegram');                                   // never include the address: it contains the token
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (res.ok && json.ok !== false) return json.result as T;
    const msg = `Telegram answered ${res.status}${json.description ? `: ${json.description}` : ''}`;
    if (res.status === 429 || res.status >= 500) throw new StopRun(msg);
    throw new TelegramError(msg, res.status);
  }
  return {
    getMe: () => call('getMe', {}),
    getUpdates: (offset, timeout, signal) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, (timeout + 10) * 1000, signal),
    sendMessage: (chat_id, text, reply_markup) => call('sendMessage', { chat_id, text, disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) }),
    answerCallbackQuery: (callback_query_id, text) => call('answerCallbackQuery', { callback_query_id, ...(text ? { text } : {}) }),
    deleteMessage: (chat_id, message_id) => call('deleteMessage', { chat_id, message_id }),
  };
}
