import { describe, expect, it } from "vitest";
import { HttpError } from "@/server/http/respond";
import { MAX_CAPTURE_IMAGE_BYTES, parseCapture, parseMultipartCapture } from "@/server/resolve/extension";

/** What an Android share sheet or an iOS Shortcut posts. */
function form(fields: Record<string, string>, image?: { bytes: Uint8Array; type: string }): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  if (image) data.set("image", new File([image.bytes as BlobPart], "shot.png", { type: image.type }));
  return data;
}

describe("parseMultipartCapture", () => {
  it("reads the text parts a share sheet sends", async () => {
    const payload = await parseMultipartCapture(
      form({ url: "https://example.com/post", title: "A post", text: "The body of the post" }),
    );
    expect(payload.url).toBe("https://example.com/post");
    expect(payload.title).toBe("A post");
    expect(payload.text).toBe("The body of the post");
  });

  it("accepts `summary` as an alias for the description", async () => {
    const payload = await parseMultipartCapture(form({ url: "https://example.com", summary: "What it is." }));
    expect(payload.description).toBe("What it is.");
  });

  it("splits a comma-separated tag field", async () => {
    const payload = await parseMultipartCapture(form({ url: "https://example.com", tags: "design, to-read, design" }));
    expect(payload.tags).toEqual(["design", "to-read", "design"]);
  });

  it("inlines an attached image as base64 with its content type", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const payload = await parseMultipartCapture(form({ url: "https://example.com" }, { bytes, type: "image/png" }));
    expect(payload.imageBase64).toBe(Buffer.from(bytes).toString("base64"));
    expect(payload.imageContentType).toBe("image/png");
  });

  it("refuses an image over the ceiling instead of buffering it", async () => {
    const bytes = new Uint8Array(MAX_CAPTURE_IMAGE_BYTES + 1);
    await expect(parseMultipartCapture(form({ url: "https://example.com" }, { bytes, type: "image/png" }))).rejects.toThrow(
      /larger than 8 MB/,
    );
  });

  it("rejects a share with no URL, because there is nothing to file", async () => {
    await expect(parseMultipartCapture(form({ text: "just some text" }))).rejects.toThrow(/Invalid capture payload/);
  });

  it("ignores empty fields rather than storing blank strings", async () => {
    const payload = await parseMultipartCapture(form({ url: "https://example.com", title: "   ", author: "" }));
    expect(payload.title).toBeUndefined();
    expect(payload.author).toBeUndefined();
  });
});

describe("parseCapture", () => {
  it("accepts the JSON shape the extension posts", () => {
    const payload = parseCapture({ url: "https://x.com/a/status/1", title: "A tweet", platform: "x" });
    expect(payload.platform).toBe("x");
  });

  it("reports which field was wrong, as a 400", () => {
    for (const body of [{ url: "no" }, { title: "no url" }, {}]) {
      let thrown: unknown;
      try {
        parseCapture(body);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(400);
      // The offending field is named in the details, not swallowed.
      expect(JSON.stringify((thrown as HttpError).details)).toContain("url");
    }
  });
});
