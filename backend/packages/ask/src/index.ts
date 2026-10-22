// "Ask DEODScan AI", assembled from backend/.env: OPENAI_API_KEY (required), OPENAI_MODEL, ASK_DAILY_LIMIT. Without a key it is simply off, and
// nothing else in DEODScan depends on it.
import type pg from 'pg';
import { loadEnv } from '@deod/config';
import { LlmError, openAiClient, type LlmClient } from './llm.js';
import { MAX_QUESTION_CHARS, runAsk, type AskResult, type Turn } from './ask.js';
import { recordUsage, refundQuestion, reserveQuestion, usageToday, type Usage } from './limits.js';

export * from './ask.js';
export * from './llm.js';
export * from './verify.js';
export { TOOLS, toolDefs } from './tools.js';
export * from './limits.js';

export interface AskStatus { enabled: boolean; reason: string | null; model: string | null; maxQuestionChars: number; usage: Usage | null }

export interface AskService {
  status(): Promise<AskStatus>;
  ask(question: string, opts?: { defaultRange?: string; signal?: AbortSignal; history?: Turn[] }): Promise<AskResult & { remainingToday: number }>;
}

/** `llm` can be passed in (tests); otherwise the OpenAI client is built from backend/.env, or the service reports that it is off. */
export function createAsk(db: pg.Pool, llm?: LlmClient | null): AskService {
  const env = loadEnv();
  const limit = env.ASK_DAILY_LIMIT;
  const client = llm !== undefined ? llm : env.OPENAI_API_KEY ? openAiClient(env.OPENAI_API_KEY, env.OPENAI_MODEL) : null;
  const off = 'The AI assistant is not set up. Add OPENAI_API_KEY to backend/.env and restart the backend.';

  return {
    async status() {
      return { enabled: !!client, reason: client ? null : off, model: client?.model ?? null, maxQuestionChars: MAX_QUESTION_CHARS, usage: await usageToday(db, limit).catch(() => null) };
    },
    async ask(question, opts = {}) {
      if (!client) throw new LlmError(off, 'auth');
      const q = question.trim();
      if (!q || q.length > MAX_QUESTION_CHARS) throw new LlmError(!q ? 'Please type a question.' : `Please keep the question under ${MAX_QUESTION_CHARS} characters.`, 'other');
      if (!(await reserveQuestion(db, limit))) throw new LlmError(`The daily limit of ${limit} questions has been reached. It resets at 00:00 UTC (the owner can raise ASK_DAILY_LIMIT).`, 'quota');
      try {
        const r = await runAsk(db, client, q, opts);
        await recordUsage(db, { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, unverified: !r.verified });
        return { ...r, remainingToday: (await usageToday(db, limit)).remaining };
      } catch (e) {
        await recordUsage(db, { failed: true }).catch(() => {});
        throw e;
      }
    },
  };
}
