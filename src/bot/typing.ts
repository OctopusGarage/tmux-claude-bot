import { timeApi } from "../utils/timing.js";

export interface TypingApi {
  sendChatAction(chatId: number, action: "typing"): Promise<unknown>;
}

// Telegram's "typing" status auto-clears after ~5s, so refresh a little under
// that to keep the indicator continuously visible while Claude works.
const DEFAULT_INTERVAL_MS = 4500;

/**
 * Show a continuous "typing…" indicator in the chat while a long task runs.
 * Fires immediately, then refreshes on an interval. Returns a stop function to
 * call when the task completes. Errors are swallowed — the indicator is cosmetic.
 */
export function startTyping(
  api: TypingApi,
  chatId: number,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  const tick = (): void => {
    void timeApi("sendChatAction(typing)", () => api.sendChatAction(chatId, "typing")).catch(
      () => {},
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  // Don't let the refresh timer keep the process alive on its own.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
