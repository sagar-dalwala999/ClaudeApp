import { describe, expect, it } from "vitest";
import { noteSeed, renderNoteSeed } from "@/server/text/notes";

describe("renderNoteSeed", () => {
  it("renders one bulleted line per point", () => {
    expect(renderNoteSeed(["  Launched  a site ", "Second point"])).toBe("· Launched a site\n· Second point");
  });

  it("drops points that carry no text", () => {
    expect(renderNoteSeed(["", "   "])).toBe("");
  });
});

describe("noteSeed", () => {
  it("fills a note that has nothing in it", () => {
    expect(noteSeed(["A point"], null, false)).toBe("· A point");
    expect(noteSeed(["A point"], "  ", false)).toBe("· A point");
  });

  it("writes nothing when the model returned no usable point", () => {
    expect(noteSeed([], "written by hand", true)).toBeUndefined();
    expect(noteSeed(["  "], null, true)).toBeUndefined();
  });

  it("replaces a draft of ours with the newer lines", () => {
    expect(noteSeed(["New point"], "· Old point", true)).toBe("· New point");
  });

  it("never overwrites a note the owner wrote or edited", () => {
    expect(noteSeed(["A point"], "mine, keep it", false)).toBeUndefined();
    expect(noteSeed(["A point"], "· Old point, plus my own line", false)).toBeUndefined();
  });
});