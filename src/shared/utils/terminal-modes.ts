/** Best-effort cleanup for terminal modes commonly left behind by TUIs. */
export const TERMINAL_MODE_RESET_SEQUENCE =
  "\x1b[<u\x1b[<u\x1b[<u" + // Pop Kitty keyboard protocol stacks.
  "\x1b[>4;0m" + // Disable xterm modifyOtherKeys.
  "\x1b[?1004l" + // Disable focus tracking.
  "\x1b[?2004l"; // Disable bracketed paste.

export function writeTerminalModeReset(stream: { write(data: string): unknown } | undefined): void {
  try {
    stream?.write(TERMINAL_MODE_RESET_SEQUENCE);
  } catch {
    // Best-effort terminal cleanup must never mask the real exit path.
  }
}
