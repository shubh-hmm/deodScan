// "Ask DEODScan AI": one question in, one checked answer out.
//
// The language model only (1) decides which of our read-only tools to call and (2) words the answer. It never writes SQL and never sees
// anything except what those tools return. Before an answer is shown, every figure in it is looked up in the tool results (verify.ts);
// if a figure cannot be matched, the model gets one chance to correct it, and if it still cannot, the answer is withheld and only the
// retrieved data is shown. So a wrong number cannot reach the screen as a verified answer.
import type { Db } from 'mongodb';
import { collectFigures, extractFigures, verifyAnswer, type Figure } from './verify.js';
import { TOOLS, toolDefs } from './tools.js';
import { LlmError, type LlmClient, type Msg } from './llm.js';
import { dataAnchor } from '@deod/analytics';

export const MAX_STEPS = 8;
export const MAX_QUESTION_CHARS = 500;
const MAX_OUTPUT_TOKENS = 1500;
const MAX_TOOL_RESULT_CHARS = 24_000;

export interface ToolRecord { tool: string; args: unknown; result: unknown; error?: string }

export interface AskResult {
  answer: string;
  verified: boolean;                 // every figure in the answer was found in the retrieved data
  unverified: string[];              // figures that could not be matched (only when verified is false)
  data: ToolRecord[];                // everything the answer is based on, shown to the user as supporting data
  usage: { inputTokens: number; outputTokens: number; modelCalls: number };
  model: string;
}

const WITHHELD = 'I could not produce an answer whose figures I could check against your data, so I am not showing one. The data I looked up is listed below.';

export function systemPrompt(now: Date, defaultRange: string): string {
  return `You are DEODScan Assistant, the question-answering helper inside the DEODScan dashboard. DEODScan monitors DEOD (Decentrawood) token transfers on BNB Chain: deposits to and withdrawals from several centralised exchanges, and PancakeSwap V2/V3 swaps.

Current time: ${now.toISOString()} (UTC). If the user names no period, use "${defaultRange}" and say which period you used.

How you work:
- Answer ONLY from the tools. Call the tools you need; never answer from memory or guess. If the tools return nothing, say there is no recorded data for that.
- Quote figures exactly as the tools return them (you may shorten with K, M or B and round, e.g. 1,270,524.83 can be written 1.27M). NEVER add, subtract, multiply, divide, average or compute percentages yourself, and never invent a number: a figure that does not appear in the tool results will be rejected. If a total is needed and no tool returns it, say so, or call a tool that returns it (get_overview and get_dashboard_summary already include totals, net flow and changes against the previous period).
- Terms: an exchange deposit (IN) means a wallet sent DEOD to the exchange; a withdrawal (OUT) means the exchange sent DEOD to a wallet; net = deposits minus withdrawals. Amounts are in DEOD unless marked USD. All times are UTC.
- Completeness: data is synced once per finished UTC day and only covers transfers with the monitored exchange addresses and swaps on the monitored pools. When the question is about all-time totals, "latest" or "today", or an exchange that may be new, call get_data_coverage and tell the user about any gap (data not yet synced, or history that starts later for some exchanges).
- When you list transfers or swaps, show for each one: the amount, the direction or side (deposit/withdrawal, buy/sell), the time, the wallet address (full, 0x...; for a swap that is the "trader") and the transaction hash (full). If the user asks for something different, such as only addresses, give exactly that from the data you already have or fetch it again; the tool results contain the wallet addresses.
- Earlier messages in this conversation are context only (for follow-ups such as "show me the addresses" or "and last month?"). Do not reuse figures from earlier answers: look them up again with the tools.
- Never describe a wallet as a whale, bot, insider, market maker or any other kind of actor: you only know amounts and counterparties. Give no price predictions and no investment advice.
- If the question is not about DEOD data on this dashboard, say briefly that you can only answer questions about the DEOD data shown here.
- Keep answers short and plain: a few sentences or a short list.`;
}

function trim(result: unknown): unknown {
  const text = JSON.stringify(result);
  return text.length <= MAX_TOOL_RESULT_CHARS ? result : { truncated: true, note: 'The result was too large and was cut; ask for a narrower period or fewer rows.', head: text.slice(0, MAX_TOOL_RESULT_CHARS) };
}

async function runTool(db: Db, now: Date, anchor: Date | null, name: string, rawArgs: string): Promise<ToolRecord> {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) return { tool: name, args: rawArgs, result: null, error: `There is no tool called "${name}".` };
  let parsed: unknown;
  try { parsed = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { tool: name, args: rawArgs, result: null, error: 'The arguments were not valid JSON.' }; }
  const args = spec.args.safeParse(parsed);
  if (!args.success) return { tool: name, args: parsed, result: null, error: `Invalid arguments: ${args.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}` };
  try {
    return { tool: name, args: args.data, result: trim(await spec.run(args.data, { db, now, anchor })) };
  } catch (e) {
    return { tool: name, args: args.data, result: null, error: e instanceof Error ? e.message.slice(0, 300) : 'The tool failed.' };
  }
}

/** An earlier question and its answer, so follow-ups ("show me the addresses") make sense. Context only: its figures are NOT accepted as verified. */
export interface Turn { question: string; answer: string }
export const MAX_HISTORY_TURNS = 3;
const MAX_HISTORY_ANSWER_CHARS = 1500;

export interface AskOptions { now?: Date; defaultRange?: string; signal?: AbortSignal; history?: Turn[] }

export async function runAsk(db: Db, llm: LlmClient, question: string, opts: AskOptions = {}): Promise<AskResult> {
  const now = opts.now ?? new Date();
  const anchor = await dataAnchor(db).catch(() => null);
  const q = question.trim();
  if (!q) throw new LlmError('Please type a question.', 'other');
  if (q.length > MAX_QUESTION_CHARS) throw new LlmError(`Please keep the question under ${MAX_QUESTION_CHARS} characters.`, 'other');

  const tools = toolDefs();
  const earlier: Msg[] = (opts.history ?? []).slice(-MAX_HISTORY_TURNS).flatMap((t): Msg[] => [
    { role: 'user', content: t.question.slice(0, MAX_QUESTION_CHARS) },
    { role: 'assistant', content: t.answer.slice(0, MAX_HISTORY_ANSWER_CHARS) },
  ]);
  const messages: Msg[] = [{ role: 'system', content: systemPrompt(now, opts.defaultRange ?? '7d') }, ...earlier, { role: 'user', content: q }];
  const records: ToolRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  let corrections = 0;
  const result = (answer: string, verified: boolean, unverified: string[] = []): AskResult => ({ answer, verified, unverified, data: records, usage, model: llm.model });

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await llm.complete(messages, tools, { maxOutputTokens: MAX_OUTPUT_TOKENS, signal: opts.signal });
    usage.modelCalls++; usage.inputTokens += reply.inputTokens; usage.outputTokens += reply.outputTokens;

    if (reply.toolCalls.length) {
      messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls });
      // The calls are independent reads, so they run together; every call gets exactly one tool message back.
      const done = await Promise.all(reply.toolCalls.map((c) => runTool(db, now, anchor, c.function.name, c.function.arguments)));
      reply.toolCalls.forEach((c, i) => {
        const r = done[i]!;
        records.push(r);
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(r.error ? { error: r.error } : r.result) });
      });
      continue;
    }

    if (reply.finishReason === 'length') throw new LlmError('The answer was too long to finish. Please ask a narrower question.', 'other');
    const text = (reply.content ?? '').trim();
    if (!text) throw new LlmError('The model returned an empty answer. Please try again.', 'other');

    // Check every figure against what the tools returned (and the question itself).
    const allowed: Figure[] = [...records.flatMap((r) => collectFigures(r.result)), ...extractFigures(q)];
    const check = verifyAnswer(text, allowed);
    if (check.ok) return result(text, true);
    if (corrections === 0) {
      corrections++;
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `These figures in your answer do not appear in the tool results: ${check.unverified.join(', ')}. Use only figures exactly as the tools returned them (call a tool if you need one), do not compute new numbers, and answer again.` });
      continue;
    }
    return result(WITHHELD, false, check.unverified);
  }
  throw new LlmError('The question needed too many steps. Please ask something narrower.', 'other');
}
