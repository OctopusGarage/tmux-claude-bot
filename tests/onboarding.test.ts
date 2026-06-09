import { describe, expect, it } from "vitest";
import {
  maskToken,
  parseCaptureUpdate,
  parseEnv,
  serializeEnv,
  validateTokenShape,
} from "../src/core/onboarding.js";

describe("parseEnv", () => {
  it("parses KEY=value lines, ignoring comments and blanks", () => {
    const m = parseEnv("# comment\nA=1\n\nB=two=three\n");
    expect(m.get("A")).toBe("1");
    expect(m.get("B")).toBe("two=three");
    expect(m.size).toBe(2);
  });

  it("returns an empty map for empty input", () => {
    expect(parseEnv("").size).toBe(0);
  });
});

describe("serializeEnv", () => {
  const tpl = "BOT_TOKEN=your_telegram_bot_token\nCD_ALLOWED_DIRS=\nHTTP_PROXY=\n";

  it("overrides template values and preserves untouched keys and order", () => {
    const out = serializeEnv(tpl, { BOT_TOKEN: "123:abc", CD_ALLOWED_DIRS: "/home/user" });
    expect(out).toBe("BOT_TOKEN=123:abc\nCD_ALLOWED_DIRS=/home/user\nHTTP_PROXY=\n");
  });

  it("preserves comments and blank lines", () => {
    const out = serializeEnv("# header\n\nA=1\n", { A: "2" });
    expect(out).toBe("# header\n\nA=2\n");
  });

  it("appends keys not present in the template", () => {
    expect(serializeEnv("A=1\n", { B: "2" })).toBe("A=1\nB=2\n");
  });

  it("round-trips with parseEnv", () => {
    const out = serializeEnv(tpl, { BOT_TOKEN: "tkn" });
    expect(parseEnv(out).get("BOT_TOKEN")).toBe("tkn");
  });

  it("renders only appended keys for an empty template", () => {
    expect(serializeEnv("", { A: "1", B: "2" })).toBe("A=1\nB=2\n");
  });
});

describe("parseCaptureUpdate", () => {
  it("extracts id and username from a message update", () => {
    expect(parseCaptureUpdate({ message: { from: { id: 42, username: "alice" } } })).toEqual({
      id: "42",
      username: "alice",
    });
  });

  it("extracts id when username is absent", () => {
    expect(parseCaptureUpdate({ message: { from: { id: 7 } } })).toEqual({ id: "7" });
  });

  it("returns null when there is no sender", () => {
    expect(parseCaptureUpdate({ message: {} })).toBeNull();
    expect(parseCaptureUpdate({})).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(parseCaptureUpdate(null)).toBeNull();
    expect(parseCaptureUpdate(undefined)).toBeNull();
  });

  it("accepts the numeric id 0", () => {
    expect(parseCaptureUpdate({ message: { from: { id: 0 } } })).toEqual({ id: "0" });
  });
});

describe("validateTokenShape", () => {
  it("accepts a well-formed token", () => {
    expect(validateTokenShape(`123456:${"A".repeat(35)}`)).toBe(true);
  });
  it("rejects malformed tokens", () => {
    expect(validateTokenShape("nope")).toBe(false);
    expect(validateTokenShape("")).toBe(false);
  });

  it("rejects below-minimum id and secret lengths", () => {
    expect(validateTokenShape(`12345:${"A".repeat(35)}`)).toBe(false); // 5-digit id
    expect(validateTokenShape(`123456:${"A".repeat(29)}`)).toBe(false); // 29-char secret
  });
});

describe("maskToken", () => {
  it("shows only the last 4 characters", () => {
    expect(maskToken("123456:ABCDEFGH")).toBe("••••EFGH");
  });
  it("fully masks very short input", () => {
    expect(maskToken("abc")).toBe("••••");
  });
});
