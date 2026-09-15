import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnrichmentResponse } from "@/server/enrich/prompts";

// Provider configuration is memoized at module load; each case intentionally
// reloads the known module after installing its isolated environment.
function configure(overrides: Record<string, string> = {}): void {
  vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/test");
  vi.stubEnv("AUTH_SECRET", "test-secret-at-least-sixteen-characters");
  vi.stubEnv("AI_BASE_URL", "http://provider.test/v1");
  vi.stubEnv("AI_CHAT_MODEL", "chat-model");
  vi.stubEnv("AI_API_KEY", "");
  vi.stubEnv("AI_EMBED_MODEL", "");
  vi.stubEnv("AI_JSON_MODE", "prompt");
  vi.stubEnv("AI_MAX_TOKENS_PARAM", "max_tokens");
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

function completion(content = '{"ok":true}'): Response {
  return Response.json({
    model: "served-model",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OpenAI-compatible provider client", () => {
  it("supports an unauthenticated local provider and prompt-only JSON", async () => {
    configure();
    const originalMessages = [{ role: "user" as const, content: "Return an object" }];
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.max_tokens).toBe(321);
      expect(body.response_format).toBeUndefined();
      expect(body.messages).toHaveLength(2);
      return completion("```json\n{\"ok\":true}\n```");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { completeJson } = await import("@/server/enrich/openai");

    const result = await completeJson<{ ok: boolean }>({
      messages: originalMessages,
      schemaName: "result",
      schema: { type: "object" },
      maxOutputTokens: 321,
    });
    expect(result.data).toEqual({ ok: true });
    expect(result.model).toBe("served-model");
    expect(originalMessages).toHaveLength(1);
  });

  it("downgrades unsupported structured-output modes in auto mode", async () => {
    configure({ AI_JSON_MODE: "auto" });
    const formats: Array<string | null> = [];
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type?: string } };
      formats.push(body.response_format?.type ?? null);
      if (formats.length === 1) return Response.json({ error: { message: "json_schema unsupported" } }, { status: 400 });
      if (formats.length === 2) return Response.json({ error: { message: "json_object unsupported" } }, { status: 422 });
      return completion();
    });
    vi.stubGlobal("fetch", fetchMock);
    const { completeJson } = await import("@/server/enrich/openai");

    await expect(completeJson({ messages: [], schemaName: "result", schema: { type: "object" } })).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(formats).toEqual(["json_schema", "json_object", null]);
  });

  it("sends no token ceiling unless one is configured", async () => {
    configure({ AI_API_KEY: "provider-secret", AI_JSON_MODE: "json-object" });
    vi.stubGlobal("fetch", vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBeUndefined();
      return completion();
    }));
    const { completeJson, embeddingsConfigured } = await import("@/server/enrich/openai");

    expect(embeddingsConfigured()).toBe(false);
    await completeJson({ messages: [], schemaName: "result", schema: { type: "object" } });
  });

  it("sends the configured ceiling under the configured parameter name", async () => {
    configure({ AI_JSON_MODE: "json-object", AI_MAX_TOKENS_PARAM: "max_completion_tokens", AI_MAX_OUTPUT_TOKENS: "2000" });
    vi.stubGlobal("fetch", vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.max_completion_tokens).toBe(2000);
      expect(body.max_tokens).toBeUndefined();
      return completion();
    }));
    const { completeJson } = await import("@/server/enrich/openai");

    await completeJson({ messages: [], schemaName: "result", schema: { type: "object" } });
  });

  it("salvages JSON the model wrapped in prose", async () => {
    configure({ AI_JSON_MODE: "json-object" });
    vi.stubGlobal("fetch", vi.fn(async () => completion('Sure — here it is:\n{"ok":true}\nLet me know if you want more.')));
    const { completeJson } = await import("@/server/enrich/openai");

    await expect(completeJson({ messages: [], schemaName: "result", schema: { type: "object" } })).resolves.toMatchObject({
      data: { ok: true },
    });
  });

  it("steps down a mode when the reply is unusable rather than invalid", async () => {
    configure({ AI_JSON_MODE: "auto" });
    const formats: Array<string | null> = [];
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { type?: string } };
      formats.push(body.response_format?.type ?? null);
      if (formats.length === 1) return completion("I would rather describe this in a paragraph.");
      return completion();
    });
    vi.stubGlobal("fetch", fetchMock);
    const { completeJson } = await import("@/server/enrich/openai");

    await expect(completeJson({ messages: [], schemaName: "result", schema: { type: "object" } })).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(formats).toEqual(["json_schema", "json_object"]);
  });

  it("reports a truncated answer instead of repeating the request", async () => {
    configure({ AI_JSON_MODE: "json-object" });
    const fetchMock = vi.fn(async () =>
      Response.json({
        model: "served-model",
        choices: [{ message: { content: '{"ok":' }, finish_reason: "length" }],
        usage: { prompt_tokens: 4, completion_tokens: 1200 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { completeJson } = await import("@/server/enrich/openai");

    await expect(completeJson({ messages: [], schemaName: "result", schema: { type: "object" } })).rejects.toThrow(
      "ran out of output tokens",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reinterpret authentication errors as capability errors", async () => {
    configure({ AI_JSON_MODE: "auto" });
    const fetchMock = vi.fn(async () => Response.json({ error: { message: "bad key" } }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const { completeJson } = await import("@/server/enrich/openai");

    await expect(completeJson({ messages: [], schemaName: "result", schema: { type: "object" } })).rejects.toThrow(
      "AI provider responded 401",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects schema-invalid JSON before enrichment consumes it", () => {
    expect(() => parseEnrichmentResponse(null)).toThrow("invalid enrichment object");
    expect(() => parseEnrichmentResponse({ title: "Only a title" })).toThrow("invalid enrichment object");
  });

  it("rejects embedding dimensions the database cannot store", async () => {
    configure({ AI_EMBED_MODEL: "small-vector-model" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      model: "small-vector-model",
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 1 },
    })));
    const { embedTexts } = await import("@/server/enrich/openai");

    await expect(embedTexts(["query"])).rejects.toThrow("1536");
  });
});
