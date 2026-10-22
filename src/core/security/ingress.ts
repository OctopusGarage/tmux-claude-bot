import { messages } from "../i18n/index.js";
import { withRemoteAccessContext } from "./context.js";
import type { RemoteAccessService, RemotePrincipal } from "./remote-access.js";

type RemoteIngress = {
  service?: RemoteAccessService | undefined;
  principal: RemotePrincipal;
  privateChat: boolean;
  text?: string | undefined;
  reply: (text: string) => Promise<unknown>;
  sendPrivate: (text: string) => Promise<unknown>;
  removeSensitive?: (() => Promise<unknown>) | undefined;
  run: () => Promise<void>;
};

/** Handle security commands before content routing, transcription or callbacks. */
export async function runRemoteIngress(input: RemoteIngress): Promise<boolean> {
  const { service, principal } = input;
  if (!service) {
    await input.run();
    return true;
  }
  const m = messages(principal.channel);
  const text = input.text?.trim() ?? "";
  const command = /^\/(unlock|approve|lock|security)(?:@\w+)?(?:\s|$)/i
    .exec(text)?.[1]
    ?.toLowerCase();
  const parts = text.split(/\s+/);
  const remove = async () => {
    try {
      await input.removeSensitive?.();
    } catch {
      /* Best effort; codes are never echoed. */
    }
  };
  if (command) {
    if (command === "approve") await remove();
    try {
      if (command === "security") {
        const status = service.status();
        await input.reply(
          status.suspended
            ? m.securitySuspended
            : status.enabled
              ? m.securityEnabled
              : m.securityCompatibility,
        );
      } else if (command === "lock") {
        service.lock(principal);
        await input.reply(m.securityRevoked);
      } else if (command === "unlock" && parts.length === 1) {
        const request = service.request(principal);
        await input.sendPrivate(m.securityRequest(request.id, principal.chatId));
        if (!input.privateChat) await input.reply(m.securityPrivateInstructions);
      } else if (command === "approve") {
        if (!input.privateChat) {
          await input.reply(m.securityPrivateApproval);
          return false;
        }
        if (parts.length !== 3 || !/^\d{6}$/.test(parts[2] ?? "")) {
          await input.reply(m.securityUsage);
          return false;
        }
        service.approve(principal, parts[1] ?? "", parts[2] ?? "");
        await input.reply(m.securityApproved);
      } else {
        await input.reply(m.securityUsage);
      }
    } catch {
      await input.reply(command === "approve" ? m.securityApprovalFailed : m.securityLocked);
    }
    return false;
  }
  if (/^\d{6}$/.test(text)) {
    try {
      if (service.status().enabled) {
        await remove();
        await input.reply(m.securityUsage);
        return false;
      }
    } catch {
      await input.reply(m.securityLocked);
      return false;
    }
  }
  let run: Promise<void>;
  try {
    run = withRemoteAccessContext(service, principal, input.run);
  } catch {
    await input.reply(m.securityLocked);
    return false;
  }
  await run;
  return true;
}
