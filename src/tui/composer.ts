/**
 * A raw-terminal line editor for the TUI prompt — the byte-stream parser is here
 * (pure + unit-tested); app.tsx does the thin Ink wiring (raw stdin + bracketed
 * paste). Bypassing Ink's parsed `useInput` is what makes multi-line PASTE work:
 * with bracketed paste on, a pasted block arrives wrapped in `ESC[200~ … ESC[201~`,
 * so its embedded newlines are inserted verbatim instead of being read as Enter.
 *
 * Keys: Enter sends · Alt+Enter inserts a newline · ←/→ ↑/↓ move · Ctrl-A/E home/end
 * of line · Backspace · Esc / Ctrl-C cancel · paste inserts verbatim.
 */

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
/** Turn bracketed-paste mode on/off — written to stdout by the wiring. */
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

export interface ComposerState {
  value: string;
  cursor: number;
  /** Inside a bracketed paste that may span several stdin chunks. */
  pasting: boolean;
}

export interface ComposerResult {
  state: ComposerState;
  /** Enter was pressed outside a paste — caller should send `state.value`. */
  submit: boolean;
  /** Esc / Ctrl-C — caller should close the composer. */
  cancel: boolean;
}

const lineStartOf = (v: string, cur: number): number => v.lastIndexOf("\n", cur - 1) + 1;
const lineEndOf = (v: string, cur: number): number => {
  const nl = v.indexOf("\n", cur);
  return nl === -1 ? v.length : nl;
};

/** Process one stdin chunk against the current editor state. Recognises the
 * escape sequences that arrive atomically from a terminal; a sequence split across
 * chunks (rare) degrades to a no-op for that fragment rather than misfiring. */
export function composerStep(s: ComposerState, data: string): ComposerResult {
  let { value, cursor, pasting } = s;
  let submit = false;
  let cancel = false;
  const insert = (t: string): void => {
    value = value.slice(0, cursor) + t + value.slice(cursor);
    cursor += t.length;
  };

  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    if (pasting) {
      const end = rest.indexOf(PASTE_END);
      if (end === -1) {
        insert(rest); // paste continues into a later chunk
        break;
      }
      insert(rest.slice(0, end));
      pasting = false;
      i += end + PASTE_END.length;
      continue;
    }
    if (rest.startsWith(PASTE_START)) {
      pasting = true;
      i += PASTE_START.length;
      continue;
    }
    const c = data[i] as string;
    if (c === "\r" || c === "\n") {
      submit = true;
      break;
    }
    if (c === "\x1b") {
      if (rest.startsWith("\x1b\r") || rest.startsWith("\x1b\n")) {
        insert("\n"); // Alt+Enter
        i += 2;
        continue;
      }
      if (rest.startsWith("\x1b[C")) {
        cursor = Math.min(value.length, cursor + 1);
        i += 3;
        continue;
      }
      if (rest.startsWith("\x1b[D")) {
        cursor = Math.max(0, cursor - 1);
        i += 3;
        continue;
      }
      if (rest.startsWith("\x1b[A") || rest.startsWith("\x1b[B")) {
        const ls = lineStartOf(value, cursor);
        const col = cursor - ls;
        if (rest.startsWith("\x1b[A")) {
          if (ls > 0) {
            const prevStart = lineStartOf(value, ls - 1);
            cursor = Math.min(prevStart + col, ls - 1);
          }
        } else {
          const le = lineEndOf(value, cursor);
          if (le < value.length) {
            const nextEnd = lineEndOf(value, le + 1);
            cursor = Math.min(le + 1 + col, nextEnd);
          }
        }
        i += 3;
        continue;
      }
      cancel = true; // bare ESC
      break;
    }
    if (c === "\x7f" || c === "\b") {
      if (cursor > 0) {
        value = value.slice(0, cursor - 1) + value.slice(cursor);
        cursor -= 1;
      }
      i += 1;
      continue;
    }
    if (c === "\x01") {
      cursor = lineStartOf(value, cursor);
      i += 1;
      continue;
    }
    if (c === "\x05") {
      cursor = lineEndOf(value, cursor);
      i += 1;
      continue;
    }
    if (c === "\x03") {
      cancel = true;
      break;
    }
    if (c >= " ") {
      insert(c);
      i += 1;
      continue;
    }
    i += 1; // ignore other control bytes
  }

  return { state: { value, cursor, pasting }, submit, cancel };
}
