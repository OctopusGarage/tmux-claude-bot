import { describe, expect, it } from "vitest";
import { textOrPlaceholder } from "../../../src/adapters/lark/format.js";

describe("textOrPlaceholder", () => {
  it("returns the text as-is for non-empty output", () => {
    expect(textOrPlaceholder("hello")).toBe("hello");
  });
  it("replaces empty output with a placeholder so the API does not reject it", () => {
    expect(textOrPlaceholder("")).toBe("(无输出)");
    expect(textOrPlaceholder("   ")).toBe("(无输出)");
  });
});
