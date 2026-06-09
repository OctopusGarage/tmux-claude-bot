export function normalizeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
