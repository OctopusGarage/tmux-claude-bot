import { describe, expect, it } from "vitest";
import { keyPaletteCard } from "../../src/adapters/lark/cards.js";
import {
  buildKeyPaletteKeyboard,
  parseCallbackData,
} from "../../src/adapters/telegram/keyboards.js";
import { KEY_CHORD_PRESETS } from "../../src/core/command/key-chord.js";

describe("remote key palette contract", () => {
  it("offers the same valid chords on both channels within payload limits", () => {
    const expected = KEY_CHORD_PRESETS.flat();
    const buttons = buildKeyPaletteKeyboard("abc123").inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual(expected);
    for (const button of buttons) {
      if (!("callback_data" in button)) throw new Error("Expected a callback button");
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
      expect(parseCallbackData(button.callback_data)).toEqual({
        kind: "key",
        chord: button.text,
        sid: "abc123",
      });
    }
    const choices: unknown[] = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const node = value as {
        tag?: string;
        behaviors?: { value: { cmd?: string; arg?: string } }[];
      };
      if (node.tag === "button") choices.push(node.behaviors?.[0]?.value.arg);
      for (const item of Object.values(value)) walk(item);
    };
    walk(keyPaletteCard());
    expect(choices).toEqual(expected);
  });

  it.each(["k:-X:abc123", "k:Ctrl++Left:abc123", "k:Shift+Left:", "k:Shift+Left:abc:123"])(
    "rejects malformed callback data %s",
    (data) => expect(parseCallbackData(data)).toBeNull(),
  );
});
