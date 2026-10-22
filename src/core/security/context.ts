import { AsyncLocalStorage } from "node:async_hooks";
import type { RemoteAccessService, RemoteAuthorization, RemotePrincipal } from "./remote-access.js";

type RemoteContext = {
  service: RemoteAccessService;
  principal: RemotePrincipal;
  authorization: RemoteAuthorization | undefined;
};
const context = new AsyncLocalStorage<RemoteContext | undefined>();
const services = new WeakMap<RemoteAuthorization, RemoteAccessService>();
const principalServices = new WeakMap<RemotePrincipal, RemoteAccessService>();

/** Keep transport-authenticated provenance across asynchronous internal calls. */
export function withRemoteAccessContext<T>(
  service: RemoteAccessService,
  principal: RemotePrincipal,
  run: () => T,
): T {
  const authorization = service.capture(principal);
  if (authorization) services.set(authorization, service);
  principalServices.set(principal, service);
  return context.run({ service, principal, authorization }, run);
}

/** A queue processor must not lend its first caller's grant to later work. */
export function withQueuedRemoteContext<T>(
  authorization: RemoteAuthorization | undefined,
  run: () => T,
  principal?: RemotePrincipal,
): T {
  const original = principal ?? authorization?.principal;
  const service = authorization
    ? services.get(authorization)
    : original
      ? principalServices.get(original)
      : undefined;
  return context.run(
    service && original ? { service, principal: original, authorization } : undefined,
    run,
  );
}

export function captureRemotePrincipal(): RemotePrincipal | undefined {
  return context.getStore()?.principal;
}

/** Only durable, admitted WorkOrders transfer to their independent lifecycle policy. */
export function withAcceptedWorkOrderContext<T>(run: () => T): T {
  return context.run(undefined, run);
}

export function captureRemoteAuthorization(): RemoteAuthorization | undefined {
  const current = context.getStore();
  if (!current) return undefined;
  current.service.authorize(current.authorization);
  return current.authorization;
}

type Delivery = {
  channel?: string | undefined;
  chatId?: string | number | undefined;
  origin?: string | undefined;
  remoteAuthorization?: RemoteAuthorization | undefined;
  remotePrincipal?: RemotePrincipal | undefined;
};

/** System labels do not erase remote provenance; independent local work is separate. */
export function checkRemoteAuthorization(message: Delivery, service?: RemoteAccessService): void {
  const current = context.getStore();
  const guard = service ?? current?.service;
  if (!guard) return;
  const remoteChannel = message.channel === "telegram" || message.channel === "lark";
  if (!remoteChannel && !message.remoteAuthorization && !message.remotePrincipal && !current)
    return;
  const expected = remoteChannel
    ? {
        channel: message.channel as RemotePrincipal["channel"],
        chatId: String(message.chatId ?? ""),
      }
    : undefined;
  guard.authorize(message.remoteAuthorization ?? current?.authorization, expected);
}
