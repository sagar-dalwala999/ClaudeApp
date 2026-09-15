import { afterEach, describe, expect, it, vi } from "vitest";
// These imports are intentionally dynamic: each case must load the module
// after stubbing a different environment and reset its process-local cursor.

function configure(tokens = "alpha,beta"): void {
  vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/test");
  vi.stubEnv("AUTH_SECRET", "test-secret-at-least-sixteen-characters");
  vi.stubEnv("SCRAPE_DO_TOKENS", tokens);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Scrape.do token pool", () => {
  it("starts consecutive requests on consecutive tokens", async () => {
    configure(" alpha, beta,alpha ");
    const used: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      used.push(new URL(String(input)).searchParams.get("token") ?? "");
      return new Response("<html>ok</html>", { status: 200 });
    }));
    const { scrapeDoText, scrapeDoTokens } = await import("@/server/net/scrapeDo");

    expect(scrapeDoTokens()).toEqual(["alpha", "beta"]);
    await scrapeDoText("https://x.com/user/status/1");
    await scrapeDoText("https://x.com/user/status/2");
    expect(used).toEqual(["alpha", "beta"]);
  });

  it.each([401, 429])("fails over on provider account or concurrency response %i", async (providerStatus) => {
    configure();
    const used: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const token = new URL(String(input)).searchParams.get("token") ?? "";
      used.push(token);
      return new Response(token === "alpha" ? "provider unavailable" : "<html>ok</html>", {
        status: token === "alpha" ? providerStatus : 200,
      });
    }));
    const { scrapeDoText } = await import("@/server/net/scrapeDo");

    const result = await scrapeDoText("https://www.reddit.com/r/test/comments/abcd/post/");
    expect(result.status).toBe(200);
    expect(used).toEqual(["alpha", "beta"]);
  });

  it("does not spend another token on a transport failure response", async () => {
    configure();
    const fetchMock = vi.fn(async () => new Response("try again", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const { scrapeDoText } = await import("@/server/net/scrapeDo");

    expect((await scrapeDoText("https://x.com/user/status/1")).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts request details when the network throws", async () => {
    configure("secret-token");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("failed https://api.scrape.do/?token=secret-token");
    }));
    const { scrapeDoText } = await import("@/server/net/scrapeDo");

    await expect(scrapeDoText("https://x.com/user/status/1")).rejects.toThrow("Scrape.do request failed");
    await expect(scrapeDoText("https://x.com/user/status/1")).rejects.not.toThrow("secret-token");
  });
});
