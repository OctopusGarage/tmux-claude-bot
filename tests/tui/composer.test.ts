import { describe, expect, it } from "vitest";
import {
  type ComposerState,
  composerStep,
  PASTE_END,
  PASTE_START,
} from "../../src/tui/composer.js";

const fresh = (): ComposerState => ({ value: "", cursor: 0, pasting: false });
const feed = (start: ComposerState, ...chunks: string[]) => {
  let s = start;
  let last = { state: s, submit: false, cancel: false };
  for (const ch of chunks) {
    last = composerStep(s, ch);
    s = last.state;
  }
  return last;
};

describe("composerStep", () => {
  it("inserts printable chars at the cursor", () => {
    const r = feed(fresh(), "h", "i");
    expect(r.state.value).toBe("hi");
    expect(r.state.cursor).toBe(2);
    expect(r.submit).toBe(false);
  });

  it("Enter submits (outside a paste)", () => {
    const r = feed(fresh(), "go", "\r");
    expect(r.submit).toBe(true);
    expect(r.state.value).toBe("go");
  });

  it("Alt+Enter inserts a newline, does NOT submit", () => {
    const r = feed(fresh(), "a", "\x1b\r", "b");
    expect(r.submit).toBe(false);
    expect(r.state.value).toBe("a\nb");
  });

  it("bracketed paste inserts content verbatim (newlines kept, no submit)", () => {
    const r = feed(fresh(), `${PASTE_START}line1\nline2${PASTE_END}`);
    expect(r.submit).toBe(false);
    expect(r.state.value).toBe("line1\nline2");
    expect(r.state.pasting).toBe(false);
  });

  it("a paste split across chunks accumulates and stays in pasting until the end marker", () => {
    const a = composerStep(fresh(), `${PASTE_START}foo\n`);
    expect(a.state.pasting).toBe(true);
    expect(a.state.value).toBe("foo\n");
    const b = composerStep(a.state, `bar${PASTE_END}`);
    expect(b.state.pasting).toBe(false);
    expect(b.state.value).toBe("foo\nbar");
    expect(b.submit).toBe(false);
  });

  it("a newline INSIDE a paste is not a submit", () => {
    const r = feed(fresh(), `${PASTE_START}x\ny\r${PASTE_END}`);
    expect(r.submit).toBe(false);
    expect(r.state.value).toBe("x\ny\r");
  });

  it("arrows move the cursor; backspace deletes at the cursor", () => {
    let r = feed(fresh(), "abc"); // cursor at 3
    r = composerStep(r.state, "\x1b[D"); // left → 2
    r = composerStep(r.state, "\x1b[D"); // left → 1
    r = composerStep(r.state, "\x7f"); // delete the "a"
    expect(r.state.value).toBe("bc");
    expect(r.state.cursor).toBe(0);
  });

  it("Esc and Ctrl-C cancel", () => {
    expect(feed(fresh(), "hi", "\x1b").cancel).toBe(true);
    expect(feed(fresh(), "hi", "\x03").cancel).toBe(true);
  });

  it("Ctrl-A/Ctrl-E go to start/end of the current line", () => {
    const typed = feed(fresh(), "ab", "\x1b\r", "cd").state; // "ab\ncd" via Alt+Enter, cursor 5
    const home = composerStep(typed, "\x01").state; // start of line "cd" → index 3
    expect(home.cursor).toBe(3);
    const end = composerStep(home, "\x05").state; // end of line → 5
    expect(end.cursor).toBe(5);
  });

  it("→ moves the cursor right, clamped at end of value", () => {
    const s = { value: "abc", cursor: 1, pasting: false };
    const r1 = composerStep(s, "\x1b[C").state; // 1 → 2
    expect(r1.cursor).toBe(2);
    const r2 = composerStep({ value: "abc", cursor: 3, pasting: false }, "\x1b[C").state;
    expect(r2.cursor).toBe(3); // already at end, no move
  });

  it("ignores unhandled control bytes (e.g. Ctrl-B) without altering the value", () => {
    const r = feed(fresh(), "a", "\x02", "b"); // \x02 is not a recognised key
    expect(r.state.value).toBe("ab");
    expect(r.state.cursor).toBe(2);
    expect(r.submit).toBe(false);
    expect(r.cancel).toBe(false);
  });

  it("↓ then ↑ moves between lines keeping the column", () => {
    const s = { value: "abcd\nefgh", cursor: 2, pasting: false }; // col 2 on line 1
    const down = composerStep(s, "\x1b[B").state; // line 2, col 2 → index 5+2 = 7
    expect(down.cursor).toBe(7);
    const up = composerStep(down, "\x1b[A").state; // back to line 1 col 2
    expect(up.cursor).toBe(2);
  });
});
