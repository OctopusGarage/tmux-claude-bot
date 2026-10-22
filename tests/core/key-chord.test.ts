import { describe, expect, it } from "vitest";
import { KEY_CHORD_PRESETS, parseKeyChord } from "../../src/core/command/key-chord.js";

describe("parseKeyChord", () => {
  it.each([
    ["Shift+Left", "Shift+Left", "S-Left"],
    [" alt + control + LEFT ", "Ctrl+Alt+Left", "C-M-Left"],
    ["shift+ctrl+right", "Ctrl+Shift+Right", "C-S-Right"],
    ["Shift+Tab", "Shift+Tab", "BTab"],
    ["Ctrl+Alt+Shift+Tab", "Ctrl+Alt+Shift+Tab", "C-M-BTab"],
    ["Ctrl+c", "Ctrl+C", "C-c"],
    ["a", "a", "a"],
    ["A", "A", "A"],
    ["Shift+a", "Shift+A", "A"],
    ["Alt+Shift+a", "Alt+Shift+A", "M-A"],
    ["Escape", "Esc", "Escape"],
    ["pageup", "PageUp", "PPage"],
    ["F12", "F12", "F12"],
  ])("normalizes %s", (input, label, tmuxKey) => {
    expect(parseKeyChord(input)).toEqual({ label, tmuxKey });
  });

  it.each([
    "",
    "Ctrl",
    "Ctrl+Ctrl+Left",
    "Alt+Meta+Left",
    "Cmd+Left",
    "Ctrl++a",
    "a b",
    "C-a",
    "-X",
    "Left;kill-session",
    "Left\nRight",
    "\u001b[D",
    "F13",
    "Shift+1",
    "你好",
    "Ctrl+Space+Left",
  ])("rejects unsafe or unsupported input %j", (input) => expect(parseKeyChord(input)).toBeNull());

  it("keeps all palette chords valid and unique", () => {
    expect(new Set(KEY_CHORD_PRESETS.flat()).size).toBe(KEY_CHORD_PRESETS.flat().length);
    for (const chord of KEY_CHORD_PRESETS.flat()) expect(parseKeyChord(chord)?.label).toBe(chord);
  });
});
