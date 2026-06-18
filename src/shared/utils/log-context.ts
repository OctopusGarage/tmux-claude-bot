import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Request-scoped logging context. Established once at each ingress (adapter
 * handler, queue handler, boot) and inherited by every log line in that async
 * scope, so call sites don't thread it by hand. */
export type LogContext = {
  traceId?: string;
  session?: string;
  chatId?: string | number;
  channel?: "telegram" | "lark";
};

const als = new AsyncLocalStorage<LogContext>();

/** Run `fn` with `partial` MERGED onto the current context (nesting adds fields,
 * e.g. an ingress sets traceId/channel/chatId, then session is added later). */
export function runWithLogContext<T>(partial: LogContext, fn: () => T): T {
  return als.run({ ...(als.getStore() ?? {}), ...partial }, fn);
}

/** The ambient context, or {} when outside any scope. */
export function currentLogContext(): LogContext {
  return als.getStore() ?? {};
}

/** A short correlation id, e.g. `t_a1b2c3d4`. */
export function newTraceId(): string {
  return `t_${randomUUID().slice(0, 8)}`;
}
