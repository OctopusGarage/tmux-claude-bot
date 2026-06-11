import { describe, expect, it } from "vitest";
import { signValue, verifyValue } from "../src/adapters/lark/card-signing.js";

const SECRET = "test-secret-abc";

function withSecret(fn: () => void) {
  const prev = process.env.CARD_SIGNING_SECRET;
  process.env.CARD_SIGNING_SECRET = SECRET;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CARD_SIGNING_SECRET;
    else process.env.CARD_SIGNING_SECRET = prev;
  }
}

function withoutSecret(fn: () => void) {
  const prevCard = process.env.CARD_SIGNING_SECRET;
  const prevLark = process.env.LARK_APP_SECRET;
  delete process.env.CARD_SIGNING_SECRET;
  delete process.env.LARK_APP_SECRET;
  try {
    fn();
  } finally {
    if (prevCard !== undefined) process.env.CARD_SIGNING_SECRET = prevCard;
    if (prevLark !== undefined) process.env.LARK_APP_SECRET = prevLark;
  }
}

describe("signValue", () => {
  it("returns the value unchanged when no secret is configured", () => {
    withoutSecret(() => {
      const value = { cmd: "start" };
      expect(signValue(value)).toEqual({ cmd: "start" });
    });
  });

  it("adds a _sig field when a secret is configured", () => {
    withSecret(() => {
      const signed = signValue({ cmd: "start" }) as Record<string, unknown>;
      expect(typeof signed._sig).toBe("string");
      expect((signed._sig as string).length).toBeGreaterThan(0);
    });
  });

  it("produces the same signature for the same value", () => {
    withSecret(() => {
      const a = signValue({ cmd: "switch", sid: "abc" }) as Record<string, unknown>;
      const b = signValue({ cmd: "switch", sid: "abc" }) as Record<string, unknown>;
      expect(a._sig).toBe(b._sig);
    });
  });

  it("produces different signatures for different values", () => {
    withSecret(() => {
      const a = signValue({ cmd: "start" }) as Record<string, unknown>;
      const b = signValue({ cmd: "exit" }) as Record<string, unknown>;
      expect(a._sig).not.toBe(b._sig);
    });
  });
});

describe("verifyValue", () => {
  it("returns true when no secret is configured (signing disabled)", () => {
    withoutSecret(() => {
      expect(verifyValue({ cmd: "start" })).toBe(true);
      expect(verifyValue(null)).toBe(true);
      expect(verifyValue("string")).toBe(true);
    });
  });

  it("returns true for a correctly signed value", () => {
    withSecret(() => {
      const signed = signValue({ cmd: "start", sid: "abc" });
      expect(verifyValue(signed)).toBe(true);
    });
  });

  it("returns false when _sig is missing", () => {
    withSecret(() => {
      expect(verifyValue({ cmd: "start" })).toBe(false);
    });
  });

  it("returns false when _sig is tampered", () => {
    withSecret(() => {
      const signed = { ...(signValue({ cmd: "start" }) as Record<string, unknown>), _sig: "bad" };
      expect(verifyValue(signed)).toBe(false);
    });
  });

  it("returns false when the payload was tampered (cmd changed after signing)", () => {
    withSecret(() => {
      const signed = signValue({ cmd: "start" }) as Record<string, unknown>;
      const tampered = { ...signed, cmd: "exit" };
      expect(verifyValue(tampered)).toBe(false);
    });
  });

  it("returns false for null when a secret is configured", () => {
    withSecret(() => {
      expect(verifyValue(null)).toBe(false);
    });
  });

  it("returns false for a non-object when a secret is configured", () => {
    withSecret(() => {
      expect(verifyValue("just-a-string")).toBe(false);
    });
  });
});
