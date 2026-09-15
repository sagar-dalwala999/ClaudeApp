import { describe, expect, it } from "vitest";
import { normalizeTag, normalizeTags, tagLabel, tagStem } from "@/server/text/tags";

describe("normalizeTag", () => {
  it("folds the shapes of the same tag into one vocabulary", () => {
    for (const input of ["#Machine Learning", "machine_learning", "MachineLearning", "  machine learning  "]) {
      expect(normalizeTag(input)).toBe("machine-learning");
    }
  });

  it("strips decoration and punctuation", () => {
    expect(normalizeTag("##llm-inference")).toBe("llm-inference");
    expect(normalizeTag("Data  Science!")).toBe("data-science");
    expect(normalizeTag("open/source")).toBe("open-source");
  });

  it("keeps unicode letters instead of transliterating them", () => {
    expect(normalizeTag("Кибернетика")).toBe("кибернетика");
    expect(normalizeTag("機械学習")).toBe("機械学習");
  });

  it("rejects tags that carry no meaning", () => {
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag("#")).toBeNull();
    expect(normalizeTag("3")).toBeNull();
    expect(normalizeTag("2024")).toBeNull();
  });

  it("caps the length rather than storing an essay", () => {
    const long = "a".repeat(80);
    expect(normalizeTag(long)).toHaveLength(48);
  });
});

describe("normalizeTags", () => {
  it("deduplicates while keeping the order the model produced", () => {
    expect(normalizeTags(["AI", "#ai", "llm-inference", "ai ", "to-read"])).toEqual(["ai", "llm-inference", "to-read"]);
  });

  it("drops the unusable entries", () => {
    expect(normalizeTags(["", "42", "###", "design"])).toEqual(["design"]);
  });
});

describe("tagLabel", () => {
  it("reads like a human wrote it", () => {
    expect(tagLabel("machine-learning")).toBe("Machine learning");
    expect(tagLabel("ai")).toBe("Ai");
    expect(tagLabel("to-read")).toBe("To read");
  });
});

describe("tagStem", () => {
  it("collapses the plural forms that would otherwise fragment the vocabulary", () => {
    expect(tagStem("tutorials")).toBe("tutorial");
    expect(tagStem("papers")).toBe("paper");
    expect(tagStem("batteries")).toBe("battery");
    expect(tagStem("classes")).toBe("class");
    expect(tagStem("boxes")).toBe("box");
  });

  it("leaves short words and words that only look plural alone", () => {
    expect(tagStem("llm")).toBe("llm");
    expect(tagStem("design")).toBe("design");
    expect(tagStem("less")).toBe("less");
  });
});
