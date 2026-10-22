// The language-model side of "Ask DEODScan AI". Everything provider-specific is in this one file (OpenAI's Chat Completions API with function
// calling), behind the small LlmClient interface, so the rest of the code (and every test) never touches the network and the provider can
// be swapped by writing another openAiClient-like function. The API key is read by the caller from backend/.env and is never logged.
import OpenAI from 'openai';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export type Msg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

export interface LlmReply {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;                 // 'stop' | 'tool_calls' | 'length' | 'content_filter' | ...
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  model: string;
  complete(messages: Msg[], tools: ToolDef[], opts: { maxOutputTokens: number; signal?: AbortSignal }): Promise<LlmReply>;
}

/** A failure the person can act on, with a plain explanation (never the key, never the raw provider text). */
export class LlmError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'rate_limit' | 'quota' | 'model' | 'timeout' | 'other') { super(message); }
}

export function openAiClient(apiKey: string, model: string): LlmClient {
  const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 1 });
  return {
    model,
    async complete(messages, tools, opts) {
      try {
        const res = await client.chat.completions.create(
          {
            model,
            messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
            tools: tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
            tool_choice: 'auto',
            max_completion_tokens: opts.maxOutputTokens,
          },
          { signal: opts.signal },
        );
        const choice = res.choices[0];
        if (!choice) throw new LlmError('The model returned no answer.', 'other');
        const toolCalls = (choice.message.tool_calls ?? []).flatMap((c) => (c.type === 'function' ? [{ id: c.id, type: 'function' as const, function: { name: c.function.name, arguments: c.function.arguments } }] : []));
        return {
          content: choice.message.content ?? null,
          toolCalls,
          finishReason: choice.finish_reason,
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
        };
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if (e instanceof OpenAI.APIConnectionTimeoutError || e instanceof OpenAI.APIUserAbortError) throw new LlmError('The AI service took too long to answer. Please try again.', 'timeout');
        if (e instanceof OpenAI.APIError) {
          if (e.status === 401) throw new LlmError('The OpenAI API key was rejected. Check OPENAI_API_KEY in backend/.env.', 'auth');
          if (e.status === 429 && e.code === 'insufficient_quota') throw new LlmError('The OpenAI account has no credit or hit its spending limit. Check billing at platform.openai.com.', 'quota');
          if (e.status === 429) throw new LlmError('The AI service is busy (rate limit). Please try again in a minute.', 'rate_limit');
          if (e.status === 404 || e.status === 400 && /model/i.test(e.message)) throw new LlmError(`The model "${model}" is not available to this API key. Set OPENAI_MODEL in backend/.env to one your account can use (run: npx tsx worker/src/cli.ts ask-check).`, 'model');
          throw new LlmError(`The AI service returned an error (${e.status ?? 'no status'}).`, 'other');
        }
        throw new LlmError('Could not reach the AI service.', 'other');
      }
    },
  };
}

/** Model ids this key can use (for the ask-check command). */
export async function listModels(apiKey: string): Promise<string[]> {
  const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids.sort();
}
