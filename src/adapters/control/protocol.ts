import { join } from "node:path";
import type {
  NotificationChannelSelection,
  NotificationLevel,
  NotificationOpportunity,
  NotificationResult,
} from "../../core/notifications/gateway.js";
import type { PromptTranslateCommandResult } from "../../core/read/prompt-translation.js";
import { appStateFile } from "../../shared/state-dir.js";
import type { AgentKind } from "../../shared/types.js";

/**
 * Local control transport — the wire protocol shared by the bot's control server
 * and the terminal TUI client. NDJSON (one JSON object per line) over a unix-domain
 * socket under the state dir. The bot is the single owner of session state/queue;
 * the TUI is just another client of it (like Telegram/Lark), so prompts it sends go
 * through the SAME per-session queue and can't race the chat adapters.
 */

/** Absolute path of the control socket (under TCB_STATE_DIR). */
export function controlSocketPath(): string {
  return appStateFile("control.sock");
}

/** Candidate client socket paths. The server binds only {@link controlSocketPath},
 * but CLI/TUI clients may inherit an old app-home TCB_STATE_DIR while launchd uses
 * the newer app-home/state directory. Try the nested state socket as a compatibility
 * fallback without changing where state files are read/written. */
export function controlSocketCandidatePaths(): string[] {
  const primary = controlSocketPath();
  const configured = process.env.TCB_STATE_DIR;
  const nested = configured ? join(configured, "state", "control.sock") : null;
  return nested && nested !== primary ? [primary, nested] : [primary];
}

export type ControlCallerProvenance = {
  cwd?: string;
  pid?: number;
  source?: "control-client";
};

/** Client → server. `id` correlates the synchronous response; a `send` is acked
 * immediately and its eventual reply arrives as a `reply` event. */
export type ControlRequest = {
  id: number;
  caller?: ControlCallerProvenance;
} & (
  | { op: "snapshot" }
  | { op: "peek"; session: string; lines?: number }
  | { op: "send"; session: string; text: string; callerSession?: string }
  | { op: "control"; session: string; action: string }
  | { op: "projects" }
  | { op: "open"; sid: string; agent?: AgentKind }
  | { op: "openPath"; path: string; agent?: AgentKind }
  | { op: "openWorker"; session: string; path: string; agent?: AgentKind }
  | { op: "orphans" }
  | { op: "adopt"; pid: number }
  | { op: "recover" }
  | { op: "logs"; session: string }
  | { op: "sysload" }
  | { op: "inputs"; session: string }
  | { op: "promptTranslate"; arg: string }
  | { op: "taskAudit"; now?: number; force?: boolean }
  | {
      op: "notify";
      title: string;
      body?: string;
      channel?: NotificationChannelSelection;
      level?: NotificationLevel;
      source?: string;
      session?: string;
      attachments?: { path: string; caption?: string }[];
      opportunities?: NotificationOpportunity[];
    }
  | { op: "autopilot"; session: string; verb: string }
  | { op: "sendAttachment"; session: string; filePath: string; caption?: string }
);

export type ControlResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string };

export type PromptTranslateControlResponse = {
  body: string;
  status: PromptTranslateCommandResult;
};

export type NotifyControlResponse = NotificationResult;

/** Server → client, unsolicited. `activity` means "something changed, re-snapshot";
 * `reply`/`notify`/`error` carry a queued prompt's eventual outcome by session. */
export type ControlEvent =
  | { event: "hello"; version: string }
  | { event: "activity" }
  | { event: "reply"; session: string; output: string }
  | { event: "notify"; session: string; text: string }
  | { event: "error"; session: string; error: string };

export type ServerMessage = ControlResponse | ControlEvent;

/** Encode one protocol message as an NDJSON line. */
export function encodeLine(msg: ControlRequest | ServerMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Stateful NDJSON line splitter: feed it socket chunks, get back complete parsed
 * objects (partial trailing lines are buffered until the rest arrives).
 */
export function createLineDecoder<T>(): (chunk: string) => T[] {
  let buf = "";
  return (chunk: string): T[] => {
    buf += chunk;
    const out: T[] = [];
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          /* skip a malformed line rather than wedging the stream */
        }
      }
      nl = buf.indexOf("\n");
    }
    return out;
  };
}
