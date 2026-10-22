/** Chat-facing chord syntax; transport names never come directly from user input. */
export interface KeyChord {
  label: string;
  tmuxKey: string;
}

export const KEY_CHORD_PRESETS: readonly (readonly string[])[] = [
  ["Shift+Left", "Shift+Right"],
  ["Ctrl+Left", "Ctrl+Right"],
  ["Alt+Left", "Alt+Right"],
  ["Shift+Tab", "Ctrl+L"],
];

const MODIFIERS = new Map([
  ["ctrl", "Ctrl"],
  ["control", "Ctrl"],
  ["alt", "Alt"],
  ["meta", "Alt"],
  ["shift", "Shift"],
]);

const NAMED_KEYS = new Map<string, readonly [string, string]>([
  ["up", ["Up", "Up"]],
  ["down", ["Down", "Down"]],
  ["left", ["Left", "Left"]],
  ["right", ["Right", "Right"]],
  ["home", ["Home", "Home"]],
  ["end", ["End", "End"]],
  ["pageup", ["PageUp", "PPage"]],
  ["pagedown", ["PageDown", "NPage"]],
  ["tab", ["Tab", "Tab"]],
  ["enter", ["Enter", "Enter"]],
  ["esc", ["Esc", "Escape"]],
  ["escape", ["Esc", "Escape"]],
  ["backspace", ["Backspace", "BSpace"]],
  ["delete", ["Delete", "DC"]],
  ["insert", ["Insert", "IC"]],
  ["space", ["Space", "Space"]],
]);

/** Parse exactly one chord. No sequences, raw bytes, tmux flags, or shell syntax. */
export function parseKeyChord(input: string): KeyChord | null {
  if (
    input.length > 64 ||
    [...input].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null;
  const parts = input
    .trim()
    .split("+")
    .map((part) => part.trim());
  const base = parts.pop();
  if (!base) return null;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.toLowerCase());
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  const shifted = modifiers.has("Shift");
  let label: string;
  let key: string;
  const named = NAMED_KEYS.get(base.toLowerCase());
  if (named) {
    [label, key] = named;
  } else if (/^f(?:[1-9]|1[0-2])$/i.test(base)) {
    label = key = base.toUpperCase();
  } else if (/^[a-z]$/i.test(base)) {
    label = modifiers.size ? base.toUpperCase() : base;
    key = shifted ? label : modifiers.size ? base.toLowerCase() : base;
  } else if (/^[0-9]$/.test(base) && !shifted) {
    label = key = base;
  } else {
    return null;
  }
  const displayModifiers = ["Ctrl", "Alt", "Shift"].filter((modifier) => modifiers.has(modifier));
  const transport = [];
  if (modifiers.has("Ctrl")) transport.push("C");
  if (modifiers.has("Alt")) transport.push("M");
  if (shifted && key === "Tab") key = "BTab";
  else if (shifted && !/^[A-Z]$/.test(key)) transport.push("S");
  return { label: [...displayModifiers, label].join("+"), tmuxKey: [...transport, key].join("-") };
}
