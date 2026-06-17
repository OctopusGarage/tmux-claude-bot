import type { HandlerDeps } from "../../deps.js";
import { messages } from "../../i18n/index.js";
import type { Channel } from "../../projects/project-manager.js";
import { getPathBySession } from "../../projects/sessionPathMap.js";
import { apiHost, formatUsageLines } from "../../read/usage.js";
import { readCodexUsage, resolveCodexApiInfo } from "./codex-usage.js";

/** /status body for a codex session: running state + usage lines (no statusLine
 * install nudge — codex has none). Usage comes from the rollout JSONL tail. */
export async function buildCodexStatusReport(
  deps: HandlerDeps,
  session: string,
  channel: Channel,
  running: boolean,
  now: number = Date.now(),
): Promise<string> {
  const m = messages(channel);
  const top: string[] = [running ? m.statusRunning("Codex") : m.statusNotRunning("Codex")];
  if (!running) return top.join("\n");
  const configRoot = (await deps.configResolver.resolveCodexHome?.(session)) ?? null;
  // The endpoint/auth read (files under CODEX_HOME) and the live-rollout probe
  // (open-files) are independent — run them together. Prefer the live codex's open
  // rollout (exact when several share a cwd); else readCodexUsage falls back to the
  // newest cwd-matched rollout.
  const [api, live] = await Promise.all([
    configRoot ? resolveCodexApiInfo(configRoot) : Promise.resolve(null),
    deps.configResolver.resolveLiveTranscript?.(session) ?? Promise.resolve(null),
  ]);
  // Endpoint/auth of the running codex: API (key) vs subscription (ChatGPT login),
  // plus the base URL host; mirrors claude's line.
  if (api) {
    const label = api.mode === "api" ? m.statusModeApi : m.statusModeSubscription;
    top.push(m.statusApiLine(label, apiHost(api.baseUrl, "api.openai.com")));
  }
  const snap = await readCodexUsage({
    sessionId: session,
    configRoot,
    projectPath: getPathBySession(session),
    rolloutPath: live?.path ?? null,
  });
  const lines = snap ? formatUsageLines(snap, channel, now) : [];
  return lines.length > 0 ? [...top, ...lines].join("\n") : top.join("\n");
}
