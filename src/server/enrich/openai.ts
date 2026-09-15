/**
 * Client for OpenAI-compatible chat-completion and embedding APIs.
 *
 * Plain fetch keeps the worker independent of a vendor SDK while using the
 * same REST contract those SDKs target. AI_BASE_URL and model names select the
 * provider; local providers may leave AI_API_KEY empty.
 */
import { getEnv } from "../env";
import { EMBEDDING_DIMENSIONS } from "../db/schema";

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JsonCompletion<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      refusal?: string | null;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export function aiConfigured(): boolean {
  return Boolean(getEnv().AI_CHAT_MODEL);
}

export function embeddingsConfigured(): boolean {
  return aiConfigured() && Boolean(getEnv().AI_EMBED_MODEL);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Hostname only — never log the full base URL, which may carry credentials. */
function providerHost(): string {
  try {
    return new URL(getEnv().AI_BASE_URL).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

async function postJson(
  path: string,
  body: unknown,
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const env = getEnv();
  if (!env.AI_CHAT_MODEL) throw new AiProviderError("AI_CHAT_MODEL is not set", null, false);

  const attempts = opts.attempts ?? 1;
  const host = providerHost();
  const rawModel = (body as { model?: unknown } | null)?.model;
  const model = typeof rawModel === "string" && rawModel.length > 0 ? rawModel : "unknown";
  let lastError: AiProviderError | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
    const attemptLabel = `${attempt + 1}/${attempts}`;
    const attemptStarted = Date.now();
    let response: Response;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.AI_API_KEY) headers.authorization = `Bearer ${env.AI_API_KEY}`;
    if (env.AI_USER_AGENT) headers["user-agent"] = env.AI_USER_AGENT;

    try {
      response = await fetch(`${env.AI_BASE_URL}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
      });
    } catch (error) {
      lastError = new AiProviderError(
        `Network error calling AI provider: ${error instanceof Error ? error.message : String(error)}`,
        null,
        true,
      );
      // Log without the raw error: fetch failures can embed credential-bearing URLs.
      console.warn(`[ai] ${host} ${path} model=${model} attempt=${attemptLabel} network error latencyMs=${Date.now() - attemptStarted}${attempt + 1 < attempts ? " retrying" : ""}`);
      continue;
    }

    const text = await response.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (response.ok) {
      console.log(`[ai] ${host} ${path} model=${model} attempt=${attemptLabel} status=${response.status} latencyMs=${Date.now() - attemptStarted}${attempt > 0 ? ` retries=${attempt}` : ""}`);
      return { status: response.status, json, text };
    }

    const apiMessage = (json as { error?: { message?: string } } | null)?.error?.message;
    const retryable = response.status === 429 || response.status >= 500;
    lastError = new AiProviderError(
      `AI provider responded ${response.status}${apiMessage ? `: ${apiMessage}` : ""}`,
      response.status,
      retryable,
    );
    if (!retryable) {
      console.warn(`[ai] ${host} ${path} model=${model} attempt=${attemptLabel} status=${response.status} latencyMs=${Date.now() - attemptStarted} not retryable`);
      throw lastError;
    }
    console.warn(`[ai] ${host} ${path} model=${model} attempt=${attemptLabel} status=${response.status} latencyMs=${Date.now() - attemptStarted} retryable${attempt + 1 < attempts ? " retrying" : " giving up"}`);

    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 30) await sleep(retryAfter * 1000);
  }

  throw lastError ?? new AiProviderError("AI provider call failed", null, true);
}

export interface StructuredOptions {
  messages: ChatMessage[];
  schemaName: string;
  schema: unknown;
  maxOutputTokens?: number;
}

type JsonMode = "json-schema" | "json-object" | "prompt";

function modesFor(configured: "auto" | JsonMode): JsonMode[] {
  return configured === "auto" ? ["json-schema", "json-object", "prompt"] : [configured];
}

function requestBody(opts: StructuredOptions, mode: JsonMode, ceiling: number | null): Record<string, unknown> {
  const env = getEnv();
  const messages = mode === "prompt"
    ? [
        ...opts.messages,
        {
          role: "user" as const,
          content: `Return only valid JSON matching this JSON Schema. Do not use Markdown fences.\n${JSON.stringify(opts.schema)}`,
        },
      ]
    : opts.messages;
  const body: Record<string, unknown> = {
    model: env.AI_CHAT_MODEL,
    messages,
  };
  // No ceiling by default: a reasoning model bills its thinking against this,
  // and a ceiling small enough to cut that off is how "returned invalid JSON"
  // happens. The request timeout, not a token count, is the real bound.
  if (ceiling) body[env.AI_MAX_TOKENS_PARAM] = ceiling;
  if (mode === "json-schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: opts.schemaName, schema: opts.schema, strict: true },
    };
  } else if (mode === "json-object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

type MessageContent = string | Array<{ type?: string; text?: string }> | null | undefined;

function messageText(content: MessageContent): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content.map((part) => part?.text ?? "").join("").trim();
  return text || null;
}

function parseJsonContent<T>(content: string): T {
  const trimmed = content.trim();
  const unfenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  for (const candidate of [unfenced, balancedObject(trimmed)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next candidate: models wrap JSON in prose and fences even when
      // the schema forbids it.
    }
  }
  throw new AiProviderError("AI provider returned content that was not valid JSON", null, false);
}

/** The first complete `{...}` block, ignoring braces inside strings. */
function balancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  // Unbalanced: the answer was cut off mid-object.
  return null;
}

/**
 * Request structured JSON.
 *
 * Auto mode walks json-schema → json-object → prompt. It steps down when the
 * provider rejects the response format (400/404/422) and — just as important —
 * when the reply comes back unusable: a provider that accepts `json_schema` and
 * then ignores it would otherwise never reach the one mode that states the
 * schema in the prompt.
 */
export async function completeJson<T>(opts: StructuredOptions): Promise<JsonCompletion<T>> {
  const env = getEnv();
  const started = Date.now();
  const host = providerHost();
  const configuredModel = env.AI_CHAT_MODEL ?? "unknown";
  const modes = modesFor(env.AI_JSON_MODE);
  const ceiling = opts.maxOutputTokens ?? env.AI_MAX_OUTPUT_TOKENS;
  let lastError: AiProviderError | null = null;

  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index] as JsonMode;
    const next = modes[index + 1];
    let raw: unknown;

    try {
      ({ json: raw } = await postJson("/chat/completions", requestBody(opts, mode, ceiling), {
        attempts: 3,
        timeoutMs: 120_000,
      }));
    } catch (error) {
      const capabilityError = error instanceof AiProviderError && [400, 404, 422].includes(error.status ?? 0);
      if (!capabilityError || !next) {
        const status = error instanceof AiProviderError ? error.status : null;
        console.warn(`[ai] ${host} /chat/completions model=${configuredModel} mode=${mode} failed${status != null ? ` status=${status}` : ""} latencyMs=${Date.now() - started}`);
        throw error;
      }
      console.warn(`[ai] ${host} /chat/completions model=${configuredModel} mode=${mode} unsupported, downgrading to ${next}`);
      continue;
    }

    const parsed = raw as ChatCompletionResponse | null;
    const model = parsed?.model ?? configuredModel;
    const choice = parsed?.choices?.[0];
    const content = messageText(choice?.message?.content);
    const finishReason = choice?.finish_reason ?? null;

    // Out of room mid-answer: repeating the same request cannot help.
    if (finishReason === "length") {
      console.warn(`[ai] ${host} /chat/completions model=${model} mode=${mode} truncated finish_reason=length latencyMs=${Date.now() - started}`);
      throw new AiProviderError(
        "AI provider ran out of output tokens (finish_reason=length) — raise AI_MAX_OUTPUT_TOKENS or send a smaller prompt",
        null,
        false,
      );
    }

    let data: T | null = null;
    if (content) {
      try {
        data = parseJsonContent<T>(content);
      } catch (error) {
        lastError = error as AiProviderError;
      }
    } else {
      const refusal = choice?.message?.refusal;
      lastError = new AiProviderError(`AI provider returned no content${refusal ? `: ${refusal}` : ""}`, null, false);
    }

    if (data !== null) {
      const completion = {
        data,
        model,
        inputTokens: parsed?.usage?.prompt_tokens ?? 0,
        outputTokens: parsed?.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
      console.log(`[ai] ${host} /chat/completions model=${model} mode=${mode} ceiling=${ceiling ?? "none"} inputTokens=${completion.inputTokens} outputTokens=${completion.outputTokens} latencyMs=${completion.latencyMs}${index > 0 ? ` modeFallbacks=${index}` : ""}`);
      return completion;
    }

    console.warn(
      `[ai] ${host} /chat/completions model=${model} mode=${mode} unusable content finish_reason=${finishReason} completionTokens=${parsed?.usage?.completion_tokens ?? 0} latencyMs=${Date.now() - started} preview=${JSON.stringify((content ?? "").slice(0, 160))}`,
    );
    if (!next) break;
    console.warn(`[ai] ${host} /chat/completions model=${configuredModel} mode=${mode} unusable, retrying as ${next}`);
  }

  throw lastError ?? new AiProviderError("AI provider call failed", null, true);
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: { prompt_tokens?: number };
  model?: string;
}

export async function embedTexts(inputs: string[]): Promise<{ vectors: number[][]; model: string; inputTokens: number }> {
  const env = getEnv();
  if (!env.AI_EMBED_MODEL) throw new AiProviderError("AI_EMBED_MODEL is not set", null, false);
  const clean = inputs.map((text) => text.replace(/\s+/g, " ").trim().slice(0, 8_000)).filter((text) => text.length > 0);
  if (!clean.length) return { vectors: [], model: env.AI_EMBED_MODEL, inputTokens: 0 };

  const host = providerHost();
  const started = Date.now();
  let json: unknown;
  try {
    ({ json } = await postJson(
      "/embeddings",
      { model: env.AI_EMBED_MODEL, input: clean },
      { attempts: 3, timeoutMs: 60_000 },
    ));
  } catch (error) {
    const status = error instanceof AiProviderError ? error.status : null;
    console.warn(`[ai] ${host} /embeddings model=${env.AI_EMBED_MODEL} failed${status != null ? ` status=${status}` : ""} latencyMs=${Date.now() - started}`);
    throw error;
  }
  const parsed = json as EmbeddingResponse | null;
  const vectors = (parsed?.data ?? [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((entry) => entry.embedding ?? []);
  if (
    vectors.length !== clean.length ||
    vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value)))
  ) {
    console.warn(`[ai] ${host} /embeddings model=${parsed?.model ?? env.AI_EMBED_MODEL} returned ${vectors.length}/${clean.length} vectors latencyMs=${Date.now() - started}`);
    throw new AiProviderError(
      `Embedding response must contain ${clean.length} vectors of ${EMBEDDING_DIMENSIONS} finite numbers`,
      null,
      false,
    );
  }
  const result = { vectors, model: parsed?.model ?? env.AI_EMBED_MODEL, inputTokens: parsed?.usage?.prompt_tokens ?? 0 };
  console.log(`[ai] ${host} /embeddings model=${result.model} inputTokens=${result.inputTokens} count=${clean.length} latencyMs=${Date.now() - started}`);
  return result;
}

export async function embedText(input: string): Promise<{ vector: number[] | null; model: string; inputTokens: number }> {
  const { vectors, model, inputTokens } = await embedTexts([input]);
  return { vector: vectors[0] ?? null, model, inputTokens };
}
