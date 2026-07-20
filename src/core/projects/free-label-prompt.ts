// Two-step capture for naming an independent session from a button tap. A chat has no
// inline text field, so the new independent-session tap remembers the chat scope,
// then the user's next text message is taken as the label. Per-scope, short TTL.
// Mirrors the new-folder capture in dir-browser.ts (kept as a small parallel copy
// rather than a shared abstraction — only two such flows exist, and extracting one
// would mean refactoring the working folder flow for no functional gain).
//
// Escape hatches so an armed capture can't trap the user: the prompt carries a
// Cancel button (clearFreeLabel), the capture expires after the TTL, and a slash
// command typed while armed is intercepted by grammY's command handlers BEFORE the
// message-text handler runs — so it never gets eaten as a label.

const FREE_LABEL_TTL_MS = 5 * 60 * 1000;
const pending = new Map<string, number>();

/** Start a "name this independent session" capture for the scope. */
export function requestFreeLabel(scope: string): void {
  pending.set(scope, Date.now());
}

/** True while the scope's next text message should be taken as an independent-session label. */
export function isAwaitingFreeLabel(scope: string): boolean {
  const at = pending.get(scope);
  if (at === undefined) return false;
  if (Date.now() - at > FREE_LABEL_TTL_MS) {
    pending.delete(scope);
    return false;
  }
  return true;
}

/** Consume the pending capture; returns true if it was still live (not expired). */
export function consumeFreeLabel(scope: string): boolean {
  const at = pending.get(scope);
  pending.delete(scope);
  return at !== undefined && Date.now() - at <= FREE_LABEL_TTL_MS;
}

/** Drop a pending capture without creating anything (the "cancel" button). */
export function clearFreeLabel(scope: string): void {
  pending.delete(scope);
}
