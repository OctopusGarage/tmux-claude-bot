import { open } from "node:fs/promises";
import { matchOpenCodexRollout, readFirstLine } from "./codex-rollout.js";

export type CodexOrphanSession = {
  sessionId: string;
  busy: boolean | null;
  lastActivityAt?: number | null;
};
const HEADER_LIMIT = 64 * 1024;
const TAIL_LIMIT = 1024 * 1024;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function metadata(header: string, sessionId: string): { child: boolean } | null {
  try {
    const entry = object(JSON.parse(header));
    const payload = object(entry?.payload);
    if (entry?.type !== "session_meta" || payload?.id !== sessionId) return null;
    const source = payload.source;
    const descriptor = object(source);
    return {
      child:
        source === "subagent" || (descriptor !== null && Object.hasOwn(descriptor, "subagent")),
    };
  } catch {
    return null;
  }
}

/** Task state is evidence from this exact root's typed lifecycle, not file age. */
function busyFromTail(text: string): boolean | null {
  if (!text.endsWith("\n")) return null;
  let busy: boolean | null = null;
  let turnId: string | null = null;
  let invalidated = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = object(JSON.parse(line));
    } catch {
      return null;
    }
    if (!entry) return null;
    const payload = object(entry.payload);
    if (!payload) continue;
    if (entry.type === "response_item" && payload.type === "message") {
      if (payload.role === "user" && busy === false) {
        busy = null;
        invalidated = true;
      }
      continue;
    }
    if (
      entry.type !== "event_msg" ||
      !["task_started", "task_complete", "turn_aborted"].includes(String(payload.type))
    )
      continue;
    if (
      typeof payload.turn_id !== "string" ||
      !payload.turn_id ||
      typeof payload.root_turn_id !== "string" ||
      !payload.root_turn_id
    ) {
      busy = null;
      invalidated = true;
      continue;
    }
    if (payload.turn_id !== payload.root_turn_id) continue;
    if (payload.type === "task_started") {
      turnId = payload.turn_id;
      busy = true;
      invalidated = false;
    } else if (!invalidated && (turnId === null || turnId === payload.turn_id)) {
      turnId = payload.turn_id;
      busy = false;
    }
  }
  return busy;
}

/** Only a unique parent rollout actually open in this process is resumable.
 * Child logs can be newer and may be listed first by lsof. Ambiguity fails closed. */
export async function inspectCodexOrphanSession(
  openFiles: readonly string[],
): Promise<CodexOrphanSession | null> {
  const parents: { path: string; sessionId: string }[] = [];
  for (const path of new Set(openFiles)) {
    const match = matchOpenCodexRollout([path]);
    if (!match?.sessionId) continue;
    const meta = metadata(await readFirstLine(path, HEADER_LIMIT), match.sessionId);
    if (!meta) return null;
    if (!meta.child) parents.push({ path, sessionId: match.sessionId });
  }
  if (parents.length !== 1) return null;
  const parent = parents[0];
  if (!parent) return null;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(parent.path, "r");
    const stat = await file.stat();
    const header = Buffer.alloc(Math.min(HEADER_LIMIT, stat.size));
    const head = await file.read(header, 0, header.length, 0);
    const meta = metadata(
      header.toString("utf8", 0, head.bytesRead).split("\n")[0] ?? "",
      parent.sessionId,
    );
    if (!meta || meta.child) return null;
    const start = Math.max(0, stat.size - TAIL_LIMIT);
    const buffer = Buffer.alloc(stat.size - start);
    const tail = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8", 0, tail.bytesRead);
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0)
        return { sessionId: parent.sessionId, busy: null, lastActivityAt: stat.mtimeMs };
      text = text.slice(newline + 1);
    }
    return { sessionId: parent.sessionId, busy: busyFromTail(text), lastActivityAt: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}
