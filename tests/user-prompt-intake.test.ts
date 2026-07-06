import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareUserPromptDelivery,
  rewriteUserPromptByAck,
  userPromptQueueFields,
} from "../src/core/read/user-prompt-intake.js";

const ENV_KEYS = [
  "PROMPT_TRANSLATE_MODE",
  "PROMPT_TRANSLATE_FROM",
  "PROMPT_TRANSLATE_TO",
  "TELEGRAM_PROMPT_TRANSLATE_MODE",
  "TELEGRAM_PROMPT_TRANSLATE_FROM",
  "TELEGRAM_PROMPT_TRANSLATE_TO",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("user prompt intake", () => {
  it("keeps text prompts as user-origin queue fields when translation is off", async () => {
    const delivery = await prepareUserPromptDelivery("telegram", "ship it", "text");

    expect(delivery).toMatchObject({
      ok: true,
      text: "ship it",
      origin: "user",
      promptSource: "telegram",
      preview: { kind: "none" },
    });
    expect(delivery.ok && userPromptQueueFields(delivery)).toEqual({
      text: "ship it",
      origin: "user",
      promptSource: "telegram",
      sourceText: undefined,
      transform: undefined,
    });
  });

  it("returns a platform-neutral translated text preview and queue metadata", async () => {
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    const translate = vi.fn(async () => "Ship the feature");

    const delivery = await prepareUserPromptDelivery("telegram", "把功能做完", "text", {
      translate,
    });

    expect(delivery).toMatchObject({
      ok: true,
      text: "Ship the feature",
      preview: { kind: "text-translated", from: "zh", to: "en" },
    });
    expect(delivery.ok && userPromptQueueFields(delivery)).toMatchObject({
      text: "Ship the feature",
      origin: "user",
      promptSource: "telegram",
      sourceText: "把功能做完",
      transform: {
        kind: "translation",
        provider: "argos",
        from: "zh",
        to: "en",
        sourceText: "把功能做完",
        deliveredText: "Ship the feature",
      },
    });
  });

  it("models voice as input provenance plus optional prompt translation", async () => {
    process.env.PROMPT_TRANSLATE_MODE = "argos";

    const delivery = await prepareUserPromptDelivery("lark", "打开仪表盘", "voice", {
      translate: async () => "Open the dashboard",
    });

    expect(delivery).toMatchObject({
      ok: true,
      text: "Open the dashboard",
      preview: {
        kind: "voice-translated",
        sourceText: "打开仪表盘",
        deliveredText: "Open the dashboard",
        from: "zh",
        to: "en",
      },
    });
  });

  it("rewrites queued prompts through the same translation and metadata path", async () => {
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    const rewriteByAck = vi.fn(() => ({ kind: "rewritten", session: "s1" }) as const);
    const queue = {
      sessionByAck: vi.fn(() => "s1"),
      rewriteByAck,
    };

    const result = await rewriteUserPromptByAck(queue, {
      source: "telegram",
      ackMsgId: "ack-1",
      chatId: 123,
      text: "修复测试",
      translate: async () => "Fix the tests",
    });

    expect(result).toEqual({ kind: "rewritten", session: "s1" });
    expect(rewriteByAck).toHaveBeenCalledWith(
      "ack-1",
      123,
      "Fix the tests",
      expect.objectContaining({
        origin: "user",
        promptSource: "telegram",
        sourceText: "修复测试",
        transform: expect.objectContaining({ deliveredText: "Fix the tests" }),
      }),
    );
  });

  it("fails closed when rewrite translation fails", async () => {
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    const rewriteByAck = vi.fn();
    const queue = {
      sessionByAck: vi.fn(() => "s1"),
      rewriteByAck,
    };

    const result = await rewriteUserPromptByAck(queue, {
      source: "lark",
      ackMsgId: "ack-1",
      chatId: "chat-1",
      text: "修复测试",
      translate: async () => "",
    });

    expect(result).toEqual({ kind: "failed", reason: "translate" });
    expect(rewriteByAck).not.toHaveBeenCalled();
  });
});
