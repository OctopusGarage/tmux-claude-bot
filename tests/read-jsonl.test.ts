import { describe, expect, it } from "vitest";
import { iterJsonlObjects } from "../src/core/read/jsonl.js";

describe("iterJsonlObjects", () => {
  it("yields parsed objects, skipping blank and torn/non-JSON lines", () => {
    const text = ['{"a":1}', "", "  ", "not json{", '{"b":2}', "{bad"].join("\n");
    const got = [...iterJsonlObjects<Record<string, number>>(text)];
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("tolerates a torn final line (a live-appended transcript)", () => {
    const text = '{"payload":{"type":"token_count"}}\n{"payload":{"type":"toke';
    const got = [...iterJsonlObjects<{ payload?: { type?: string } }>(text)];
    expect(got).toHaveLength(1);
    expect(got[0]?.payload?.type).toBe("token_count");
  });

  it("does NOT swallow a throw from the consumer (yield is outside the try)", () => {
    expect(() => {
      for (const _ of iterJsonlObjects<unknown>('{"a":1}\n{"b":2}')) {
        throw new Error("consumer boom");
      }
    }).toThrow("consumer boom");
  });
});
