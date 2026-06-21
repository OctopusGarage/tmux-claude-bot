import { resolveAgentKind } from "../agents/agentKindMap.js";
import { profileFor } from "../agents/registry.js";
import type { HandlerDeps } from "../deps.js";

/** A leading interrupt marker the agent writes into the transcript when you stop a
 * turn (`[Request interrupted by user]` / `… for tool use]`) — noise, not an input
 * you'd re-run. Stripped from the front; a round that is ONLY this is skipped. */
const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]]*\]\s*/;

/** Drop a leading interrupt marker and surrounding whitespace from a transcript
 * input, leaving the real prompt (empty string if it was only the marker). */
export function stripInterruptMarker(input: string): string {
  return input.replace(INTERRUPT_MARKER, "").trim();
}

/**
 * Harness/system-injected blocks that ride along inside a transcript "user" turn
 * but are NOT something the user typed (so /inputs must not list them). Add a tag
 * here to filter a new injected wrapper — the pattern tolerates `-`/` `/`_`
 * separators and attributes, e.g. `<task notification>`, `<task-notification x="1">`.
 */
const INJECTED_TAGS = [
  "system-reminder",
  "task-notification",
  "local-command-stdout",
  "local-command-caveat",
];
const INJECTED_BLOCKS = INJECTED_TAGS.map((tag) => {
  const flex = tag.replace(/-/g, "[\\s_-]?");
  return new RegExp(`<${flex}\\b[^>]*>[\\s\\S]*?<\\/${flex}\\s*>`, "gi");
});

/** Whole-turn system messages that aren't a user input at all → skipped entirely. */
const SYSTEM_TURN_PREFIXES = [
  "This session is being continued from a previous conversation",
  "Caveat: The messages below were generated",
  "Summary:",
];

/**
 * Reduce a raw transcript "user" turn to the actual prompt the user typed, or "" if
 * the turn carried no real input (only injected notifications/reminders/command
 * output). Strips the interrupt marker + injected blocks, drops pure system turns,
 * and renders a slash-command turn back to its readable `/command` form. Shared by
 * every adapter's /inputs so the list never shows `<task notification>`-style noise.
 */
export function sanitizeRecentInput(raw: string): string {
  let text = stripInterruptMarker(raw);
  for (const re of INJECTED_BLOCKS) text = text.replace(re, "");
  text = text.trim();
  if (!text) return "";
  if (SYSTEM_TURN_PREFIXES.some((p) => text.startsWith(p))) return "";
  // A slash command is real user input, but stored as XML — show it readably.
  const nameMatch = text.match(/<command-name>\/?([\w-]+)<\/command-name>/);
  if (nameMatch) return `/${nameMatch[1]}`;
  const msgMatch = text.match(/<command-message>([\s\S]+?)<\/command-message>/);
  if (msgMatch) return (msgMatch[1] ?? "").trim();
  return text;
}

/**
 * Recent USER inputs (the prompts you typed/sent), newest-first — the same input
 * history the agent's `↑` key navigates, read from its transcript. Captures both
 * bot-sent and desktop-typed prompts. Blank rounds and interrupt markers are skipped.
 */
export async function getRecentInputs(
  deps: HandlerDeps,
  session: string,
  projectPath: string,
  limit: number,
): Promise<string[]> {
  const profile = profileFor(await resolveAgentKind(deps.configResolver, session));
  const rounds = await profile.getRecentConversations(deps.configResolver, session, projectPath);
  const inputs: string[] = [];
  for (const round of rounds) {
    const u = sanitizeRecentInput(round.user);
    if (u) inputs.push(u);
    if (inputs.length >= limit) break;
  }
  return inputs;
}

export const DEFAULT_INPUTS = 8;
export const MAX_INPUTS = 20;

/** Parse the `/inputs N` argument → count clamped to [1, MAX], default for no/bad. */
export function parseInputsLimit(arg: string | undefined): number {
  const n = arg ? Number.parseInt(arg, 10) : Number.NaN;
  if (Number.isNaN(n) || n <= 0) return DEFAULT_INPUTS;
  return Math.min(n, MAX_INPUTS);
}

/** A one-line, length-capped button label: `3. fix the failing test in …`. */
export function inputButtonLabel(prompt: string, index: number, max = 48): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const text = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return `${index + 1}. ${text}`;
}

// ── Drift-proof selection cache ──────────────────────────────────────────────
// A shown /inputs list is cached under a short token so tapping re-sends the EXACT
// prompt that was displayed — re-reading the transcript on tap could shift indices
// if a new prompt landed in between. Transient UI state: NOT persisted (rebuilt by
// running /inputs again after a restart), bounded so it can't grow unbounded.

const lists = new Map<string, { session: string; prompts: string[] }>();
let seq = 0;
const MAX_LISTS = 50;

/** Cache a shown input list, returning the token the buttons carry. */
export function storeInputList(session: string, prompts: string[]): string {
  const token = (++seq).toString(36);
  lists.set(token, { session, prompts });
  while (lists.size > MAX_LISTS) {
    const oldest = lists.keys().next().value;
    if (oldest === undefined) break;
    lists.delete(oldest);
  }
  return token;
}

/** Resolve a tapped `token:idx` back to its session + the exact prompt, or null
 * (token evicted / restarted, or a bad index). */
export function lookupInput(
  token: string,
  idx: number,
): { session: string; prompt: string } | null {
  const entry = lists.get(token);
  const prompt = entry?.prompts[idx];
  if (!entry || prompt === undefined) return null;
  return { session: entry.session, prompt };
}
