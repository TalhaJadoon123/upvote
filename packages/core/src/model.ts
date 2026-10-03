/**
 * Language model abstraction.
 *
 * Upvote never depends on a single vendor. Anything that satisfies `ModelClient`
 * can drive generation: an OpenAI-compatible endpoint, Anthropic, a local Ollama,
 * or (for tests and air-gapped demos) the built-in heuristic composer.
 */
import { z } from 'zod';

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  /** Opaque provider pass-through. */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ModelClient {
  readonly name: string;
  generate(system: string, user: string, options?: GenerateOptions): Promise<GenerateResult>;
  /** Fill-in-the-middle editing, used by the inline editor's "match my voice" button. */
  rewrite?(instruction: string, original: string, options?: GenerateOptions): Promise<GenerateResult>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible (OpenAI, Groq, Together, OpenRouter, vLLM, Ollama) */
/* ------------------------------------------------------------------ */

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Some providers (Ollama, LM Studio) do not want an Authorization header. */
  sendAuthHeader?: boolean;
  name?: string;
}

export function createOpenAICompatibleClient(config: OpenAICompatibleConfig): ModelClient {
  const name = config.name ?? `openai-compatible:${config.model}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.sendAuthHeader !== false && config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }

  return {
    name,
    async generate(system, user, options = {}) {
      return callChat(config, headers, system, user, options);
    },
    async rewrite(instruction, original, options = {}) {
      return callChat(
        config,
        headers,
        'You are a rewriting engine. Return only the rewritten text.',
        `Instruction: ${instruction}\n\nOriginal:\n${original}`,
        options,
      );
    },
  };
}

async function callChat(
  config: OpenAICompatibleConfig,
  headers: Record<string, string>,
  system: string,
  user: string,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    signal: options.signal,
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: options.temperature ?? 0.9,
      max_tokens: options.maxTokens ?? 1400,
      ...(options.extra ?? {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ModelError(
      `Model request failed: ${response.status} ${response.statusText} ${body.slice(0, 400)}`,
    );
  }

  const json = z
    .object({
      model: z.string().optional(),
      choices: z.array(
        z.object({
          message: z.object({ content: z.string().nullable() }).optional(),
        }),
      ),
      usage: z
        .object({
          prompt_tokens: z.number().optional(),
          completion_tokens: z.number().optional(),
        })
        .optional(),
    })
    .parse(await response.json());

  const text = json.choices[0]?.message?.content ?? '';
  if (!text.trim()) throw new ModelError('Model returned empty content');
  return {
    text,
    model: json.model ?? config.model,
    ...(json.usage?.prompt_tokens !== undefined ? { promptTokens: json.usage.prompt_tokens } : {}),
    ...(json.usage?.completion_tokens !== undefined
      ? { completionTokens: json.usage.completion_tokens }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                            */
/* ------------------------------------------------------------------ */

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export function createAnthropicClient(config: AnthropicConfig): ModelClient {
  const model = config.model ?? 'claude-sonnet-4-5';
  const baseUrl = (config.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
  return {
    name: `anthropic:${model}`,
    async generate(system, user, options = {}) {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: options.signal,
        body: JSON.stringify({
          model,
          system,
          max_tokens: options.maxTokens ?? 1400,
          temperature: options.temperature ?? 0.9,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ModelError(`Anthropic request failed: ${response.status} ${body.slice(0, 300)}`);
      }
      const json = z
        .object({
          model: z.string().optional(),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
          usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }),
        })
        .parse(await response.json());
      const text = json.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (!text.trim()) throw new ModelError('Anthropic returned empty content');
      return {
        text,
        model: json.model ?? model,
        ...(json.usage?.input_tokens !== undefined ? { promptTokens: json.usage.input_tokens } : {}),
        ...(json.usage?.output_tokens !== undefined
          ? { completionTokens: json.usage.output_tokens }
          : {}),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Static client (tests, fixtures, replay)                             */
/* ------------------------------------------------------------------ */

export function createStaticClient(
  responses: readonly string[],
  name = 'static',
): ModelClient & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  let i = 0;
  return {
    name,
    calls,
    async generate(system, user) {
      calls.push({ system, user });
      const text = responses[i % responses.length] ?? '';
      i++;
      return { text, model: name };
    },
    async rewrite(_instruction, original) {
      return { text: original, model: name };
    },
  };
}

/**
 * Build a client from environment variables. Returns null when no provider is
 * configured, which tells the generator to fall back to the offline composer
 * instead of failing. This is why `upvote draft` works with zero setup.
 */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): ModelClient | null {
  const openaiKey = env.OPENAI_API_KEY ?? env.OPENCODE_API_KEY;
  const openaiModel = env.UPVOTE_MODEL ?? env.OPENCODE_MODEL ?? 'gpt-4o-mini';
  if (openaiKey) {
    return createOpenAICompatibleClient({
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: openaiKey,
      model: openaiModel,
    });
  }
  if (env.ANTHROPIC_API_KEY) {
    return createAnthropicClient({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.UPVOTE_MODEL ? { model: env.UPVOTE_MODEL } : {}),
    });
  }
  if (env.OLLAMA_MODEL) {
    return createOpenAICompatibleClient({
      baseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: env.OLLAMA_MODEL,
      sendAuthHeader: false,
    });
  }
  return null;
}