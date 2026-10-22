export function shouldIgnoreUncaughtException(err: unknown, shuttingDown: boolean): boolean {
  if (!isAbortLikeError(err)) return false;
  if (shuttingDown) return true;
  return isTelegramTransportAbort(err);
}

export function isAbortLikeError(err: unknown): err is Error {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

function isTelegramTransportAbort(err: Error): boolean {
  const stack = err.stack ?? "";
  return (
    stack.includes("src/adapters/telegram/start.ts") &&
    stack.includes("src/adapters/telegram/transport/smart-fetch.ts")
  );
}
