import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentApiInfo } from "../../../shared/types.js";
import { iterJsonlObjects } from "../../read/jsonl.js";
import { numOrNull, type UsageSnapshot } from "../../read/usage.js";
import { findRolloutForProject } from "./codex-rollout.js";

interface TokenCountPayload {
  type?: string;
  info?: {
    total_token_usage?: { total_tokens?: number };
    model_context_window?: number;
  };
  rate_limits?: {
    primary?: { used_percent?: number; resets_at?: number };
    secondary?: { used_percent?: number; resets_at?: number };
  };
}

/** Parse rollout JSONL text into a UsageSnapshot from its LAST token_count event,
 * or null if none. `now` is epoch-seconds, injected for deterministic tests. */
export function codexUsageFromRollout(
  jsonlText: string,
  sessionId: string,
  now: number,
): UsageSnapshot | null {
  let last: TokenCountPayload | null = null;
  for (const obj of iterJsonlObjects<{ payload?: TokenCountPayload }>(jsonlText)) {
    if (obj.payload?.type === "token_count") last = obj.payload;
  }
  if (!last) return null;

  const total = numOrNull(last.info?.total_token_usage?.total_tokens);
  const ctxWindow = numOrNull(last.info?.model_context_window);
  const contextPct =
    total !== null && ctxWindow !== null && ctxWindow > 0
      ? // Post-compaction the running total can exceed the window, so clamp to
        // 0–100 — otherwise the numeric label would print e.g. "147%".
        Math.min(100, Math.max(0, Math.round((total / ctxWindow) * 100)))
      : null;

  return {
    sessionId,
    contextPct,
    fiveHourPct: numOrNull(last.rate_limits?.primary?.used_percent),
    fiveHourReset: numOrNull(last.rate_limits?.primary?.resets_at),
    sevenDayPct: numOrNull(last.rate_limits?.secondary?.used_percent),
    sevenDayReset: numOrNull(last.rate_limits?.secondary?.resets_at),
    updatedAt: now,
  };
}

/**
 * Resolve codex's endpoint/auth info from its file-based config under CODEX_HOME
 * (unlike claude, codex stores this in files, not process env). `auth.json`
 * decides the mode: `auth_mode === "apikey"` or a non-null `OPENAI_API_KEY` →
 * "api"; otherwise (ChatGPT login, `tokens` present) → "subscription". The base
 * URL is a custom provider's `base_url` from `config.toml`, if any (no TOML
 * dependency — the common case has none, so this returns null). Returns null
 * when `auth.json` is missing/unreadable.
 */
export function resolveCodexApiInfo(codexHome: string): Promise<AgentApiInfo | null> {
  let auth: { auth_mode?: string; OPENAI_API_KEY?: string | null };
  try {
    auth = JSON.parse(fs.readFileSync(join(codexHome, "auth.json"), "utf8"));
  } catch {
    return Promise.resolve(null);
  }
  // `OPENAI_API_KEY` presence is the dominant signal; `auth_mode` is secondary and
  // matched case-insensitively because codex writes/derives it as `ApiKey` (not
  // lowercase) on current builds.
  const isApi =
    auth.auth_mode?.toLowerCase() === "apikey" ||
    (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0);

  let baseUrl: string | null = null;
  try {
    const toml = fs.readFileSync(join(codexHome, "config.toml"), "utf8");
    baseUrl = toml.match(/base_url\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    // no config.toml / unreadable → default endpoint
  }

  return Promise.resolve({ baseUrl, mode: isApi ? "api" : "subscription" });
}

/** Resolve current codex usage for a session by parsing its rollout. Prefers the
 * caller-supplied `rolloutPath` (the live pid's open rollout — exact under
 * same-cwd contention); otherwise falls back to the newest cwd-matched rollout. */
export async function readCodexUsage(
  ctx: {
    sessionId: string;
    configRoot: string | null;
    projectPath: string | null;
    rolloutPath?: string | null;
  },
  now: number = Math.floor(Date.now() / 1000),
): Promise<UsageSnapshot | null> {
  let path = ctx.rolloutPath ?? null;
  if (!path) {
    if (!ctx.configRoot || !ctx.projectPath) return null;
    path = (await findRolloutForProject(ctx.configRoot, ctx.projectPath))?.path ?? null;
  }
  if (!path) return null;
  try {
    // Async read — the rollout can be many MB, so reading it synchronously here
    // (this runs on every /status) would block the event loop. The rest of the
    // codex fs layer is async for the same reason.
    return codexUsageFromRollout(await readFile(path, "utf8"), ctx.sessionId, now);
  } catch {
    return null;
  }
}
