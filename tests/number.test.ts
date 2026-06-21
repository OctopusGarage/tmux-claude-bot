import { describe, expect, it } from "vitest";
import { tidyFloatNoise, tidyFloatNoiseDeep } from "../src/shared/utils/number.js";

describe("tidyFloatNoise", () => {
  it("collapses float noise (long 0/9 runs) to the clean value", () => {
    expect(tidyFloatNoise("ctx 14.000000000000002%")).toBe("ctx 14%");
    expect(tidyFloatNoise("2.9999999999999996")).toBe("3");
    expect(tidyFloatNoise("-0.30000000000000004")).toBe("-0.3");
    expect(tidyFloatNoise("a 14.000000000000002 · 7d 3%")).toBe("a 14 · 7d 3%");
  });

  it("leaves legitimate numbers untouched", () => {
    expect(tidyFloatNoise("3.14159")).toBe("3.14159");
    expect(tidyFloatNoise("v0.2.0")).toBe("v0.2.0");
    expect(tidyFloatNoise("up 1d · Σ 1h23m")).toBe("up 1d · Σ 1h23m");
    expect(tidyFloatNoise("price 19.99")).toBe("price 19.99");
    // fewer than 10 zeros is not the noise signature → untouched
    expect(tidyFloatNoise("1.000001")).toBe("1.000001");
  });

  it("deep-tidies strings inside an object/array (card payloads)", () => {
    expect(
      tidyFloatNoiseDeep({ a: "ctx 14.000000000000002%", b: [{ c: "2.9999999999999996" }] }),
    ).toEqual({ a: "ctx 14%", b: [{ c: "3" }] });
  });
});
