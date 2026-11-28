import { stripVTControlCharacters } from "node:util";
import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import type {
  LiveAgentIdentity,
  LiveIdentityFailureReason,
} from "../agents/agent-config-resolver.js";
import type { HandlerDeps } from "../deps.js";
import { unmutedComposerText } from "../session/output.js";

const CONTEXT_RESET_SETTLE_MS = 250;
const CONTEXT_RESET_SUBMIT_ATTEMPTS = 3;

const log = createLogger("command.context-reset");
type ResetDiagnostics = {
  stage:
    | "input-validation"
    | "ownership"
    | "initial-identity"
    | "owned-exit"
    | "wait-for-exit"
    | "start-agent"
    | "post-start-ownership"
    | "slash-submit"
    | "slash-readiness"
    | "slash-confirmation";
  reason:
    | LiveIdentityFailureReason
    | "operation-failed"
    | "identity-unavailable"
    | "deadline-exhausted";
};
type ResetOptions = {
  settleMs?: number;
  ensureSubmitted?: boolean;
  verifyOwnership?: () => boolean;
};

/** Reset an agent's context with a slash command, or a verified fresh process
 * for owned Codex clears, and invalidate the cached transcript resolver.
 * Shared by the `/clear`,`/compact` chat commands and the autopilot between-goals step. */
export async function sendContextReset(
  deps: HandlerDeps,
  session: string,
  op: "compact" | "clear",
  options: ResetOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  const diagnostic: ResetDiagnostics = { stage: "input-validation", reason: "operation-failed" };
  try {
    await performContextReset(deps, session, op, options, diagnostic);
  } catch (error) {
    if (options.ensureSubmitted === true || options.verifyOwnership) {
      log.warn("automation context reset failed", {
        session,
        data: {
          operation: op,
          ...diagnostic,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          budgetMs: deps.config?.maxWaitReadyMs ?? null,
        },
      });
    }
    throw error;
  }
}

async function performContextReset(
  deps: HandlerDeps,
  session: string,
  op: "compact" | "clear",
  options: ResetOptions,
  diagnostic: ResetDiagnostics,
): Promise<void> {
  if (options.ensureSubmitted === true) await verifyAutomationInputPane(deps, session);
  diagnostic.stage = "ownership";
  if (options.verifyOwnership && !options.verifyOwnership())
    throw new Error("Reserved worker ownership changed before context reset");
  if (
    op === "clear" &&
    options.verifyOwnership &&
    (await restartOwnedCodexContext(deps, session, options.verifyOwnership, diagnostic))
  )
    return;
  diagnostic.stage = "slash-submit";
  await deps.bridge.sendKeys(`/${op}`, session);
  deps.configResolver.invalidate(session);
  const settleMs = options.settleMs ?? CONTEXT_RESET_SETTLE_MS;
  await sleep(settleMs);
  diagnostic.stage = "slash-readiness";
  await deps.agent.waitUntilInputReady(session);
  if (options.ensureSubmitted === true) {
    diagnostic.stage = "slash-confirmation";
    let stillInComposer = await resetCommandStillInComposer(deps, session, op);
    for (
      let attempt = 0;
      stillInComposer && attempt < CONTEXT_RESET_SUBMIT_ATTEMPTS;
      attempt += 1
    ) {
      if (options.verifyOwnership && !options.verifyOwnership())
        throw new Error("Reserved worker ownership changed before context reset confirmation");
      await deps.bridge.sendRawKey("C-m", session);
      await sleep(settleMs);
      await deps.agent.waitUntilInputReady(session);
      stillInComposer = await resetCommandStillInComposer(deps, session, op);
      if (!stillInComposer) break;
    }
    if (stillInComposer) {
      throw new Error("context reset command was not submitted before automation prompt");
    }
  }
}

/** Codex /clear can drop its rollout without replacing the native process.
 * Managed sends need a real fresh start so the dispatcher can grant the first
 * lazy-rollout submission through its existing absent-to-fresh identity gate. */
async function restartOwnedCodexContext(
  deps: HandlerDeps,
  session: string,
  verifyOwnership: () => boolean,
  diagnostic: ResetDiagnostics,
): Promise<boolean> {
  const deadline = Date.now() + deps.config.maxWaitReadyMs;
  const assertReady = (): void => {
    if (!verifyOwnership())
      throw new Error("Reserved worker ownership changed during context reset");
    if (Date.now() >= deadline) {
      diagnostic.reason = "deadline-exhausted";
      throw new Error("Agent context reset readiness deadline exhausted");
    }
  };
  const readIdentity = async (): Promise<LiveAgentIdentity> => {
    assertReady();
    const resolve = deps.configResolver.resolveLiveAgentIdentity;
    if (!resolve) throw new Error("Cannot verify live agent identity for managed context reset");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observing = true;
    diagnostic.reason = "identity-unavailable";
    try {
      const identity = await Promise.race([
        resolve.call(deps.configResolver, session, {
          onFailure: (reason) => {
            if (observing) diagnostic.reason = reason;
          },
        }),
        new Promise<null>((done) => {
          timer = setTimeout(() => done(null), Math.max(0, deadline - Date.now()));
        }),
      ]);
      assertReady();
      if (!identity) throw new Error("Cannot verify live agent identity for managed context reset");
      diagnostic.reason = "operation-failed";
      return identity;
    } finally {
      observing = false;
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  diagnostic.stage = "initial-identity";
  const before = await readIdentity();
  if (before.kind === "claude") return false;
  if (before.kind !== "codex" || before.agentPid === null)
    throw new Error("Cannot verify running Codex identity for managed context reset");
  assertReady();
  deps.agent.consumeFreshLaunch?.(session, -1);
  diagnostic.stage = "owned-exit";
  await deps.bridge.sendOwnedExit(session, {
    deadlineAt: deadline,
    verify: async () => {
      const current = await readIdentity();
      if (current.kind === null && current.agentPid === null && current.transcript === null)
        return false;
      if (current.kind !== "codex" || current.agentPid !== before.agentPid)
        throw new Error("Codex process changed during managed context reset");
      return true;
    },
  });
  deps.configResolver.invalidate(session);
  diagnostic.stage = "wait-for-exit";
  while (true) {
    const current = await readIdentity();
    if (current.kind === null && current.agentPid === null && current.transcript === null) break;
    if (current.kind !== "codex" || current.agentPid !== before.agentPid)
      throw new Error("Codex process changed during managed context reset");
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  assertReady();
  diagnostic.stage = "start-agent";
  await deps.agent.start(session, undefined, deadline);
  diagnostic.stage = "post-start-ownership";
  if (!verifyOwnership()) {
    deps.agent.consumeFreshLaunch?.(session, -1);
    throw new Error("Reserved worker ownership changed during context reset");
  }
  return true;
}

async function resetCommandStillInComposer(
  deps: HandlerDeps,
  session: string,
  op: "compact" | "clear",
): Promise<boolean> {
  const capturePane = (deps.bridge as { capturePane?: (session: string) => Promise<string> })
    .capturePane;
  if (capturePane === undefined) throw new Error("Cannot verify automation input surface");
  return activeComposerContainsResetCommand(
    await verifyAutomationInputPane(deps, session, `/${op}`),
    op,
  );
}

export async function verifyAutomationInputPane(
  deps: Pick<HandlerDeps, "bridge">,
  session: string,
  allowedComposer?: string,
): Promise<string> {
  const capturePane = (deps.bridge as { capturePane?: (session: string) => Promise<string> })
    .capturePane;
  if (capturePane === undefined) throw new Error("Cannot verify automation input surface");
  let pane: string;
  try {
    pane = await capturePane.call(deps.bridge, session);
  } catch {
    throw new Error("Cannot verify automation input surface");
  }
  if (
    pane.includes("/ T R A N S C R I P T /") ||
    /^\s*Browsing .*rewind.*esc back/m.test(pane) ||
    /^\s*•?\s*Queued follow-up inputs\s*$/m.test(pane)
  )
    throw new Error("Ambiguous automation input surface: transcript browsing or queued input");
  const composer = pane
    .split("\n")
    .reverse()
    .find((line) => /^\s*[›❯]/.test(line));
  let input = composer?.replace(/^\s*[›❯]\s*/, "").trim();
  if (
    input &&
    allowedComposer !== input &&
    !(
      allowedComposer &&
      (input.startsWith(`${allowedComposer}[`) || input.startsWith(`${allowedComposer} `))
    )
  ) {
    const captureColored = deps.bridge.capturePaneColored;
    if (captureColored) {
      let colored: string;
      try {
        colored = await captureColored.call(deps.bridge, session);
      } catch {
        throw new Error("Cannot verify automation input surface colors");
      }
      const latest = (text: string) =>
        text
          .split("\n")
          .reverse()
          .find((line) => /^\s*[›❯]/.test(line));
      if (latest(stripVTControlCharacters(colored)) !== composer)
        throw new Error("Cannot verify automation input surface: capture changed");
      input = latest(unmutedComposerText(colored))
        ?.replace(/^\s*[›❯]\s*/, "")
        .trim();
    }
  }
  if (
    input === undefined ||
    (input !== "" &&
      !(
        allowedComposer &&
        (input === allowedComposer ||
          input.startsWith(`${allowedComposer}[`) ||
          input.startsWith(`${allowedComposer} `))
      ))
  )
    throw new Error(
      "Cannot verify automation input surface: composer missing or contains pending input",
    );
  return pane;
}

function activeComposerContainsResetCommand(pane: string, op: "compact" | "clear"): boolean {
  const commandPattern = new RegExp(`^\\s*›\\s*/${op}(?:$|\\s|\\[)`);
  const lines = pane.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (commandPattern.test(line)) return true;
    if (/^\s*›/.test(line)) return false;
  }
  return false;
}
