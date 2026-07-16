import type {
  NotificationChannelSelection,
  NotificationLevel,
  NotificationResult,
} from "../../core/notifications/gateway.js";
import type { PromptTranslateCommandResult } from "../../core/read/prompt-translation.js";
import { appStateFile } from "../../shared/state-dir.js";

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

/** Client → server. `id` correlates the synchronous response; a `send` is acked
 * immediately and its eventual reply arrives as a `reply` event. */
export type ControlRequest =
  | { id: number; op: "snapshot" }
  | { id: number; op: "peek"; session: string; lines?: number }
  | { id: number; op: "send"; session: string; text: string }
  | { id: number; op: "control"; session: string; action: string }
  | { id: number; op: "projects" }
  | { id: number; op: "open"; sid: string }
  | { id: number; op: "openPath"; path: string }
  | { id: number; op: "orphans" }
  | { id: number; op: "adopt"; pid: number }
  | { id: number; op: "recover" }
  | { id: number; op: "logs"; session: string }
  | { id: number; op: "sysload" }
  | { id: number; op: "inputs"; session: string }
  | { id: number; op: "promptTranslate"; arg: string }
  | {
      id: number;
      op: "notify";
      title: string;
      body?: string;
      channel?: NotificationChannelSelection;
      level?: NotificationLevel;
      source?: string;
      session?: string;
      attachments?: { path: string; caption?: string }[];
    }
  | { id: number; op: "autopilot"; session: string; verb: string }
  | { id: number; op: "autopilotView"; session: string }
  | { id: number; op: "sendAttachment"; session: string; filePath: string; caption?: string };

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
  | { event: "error"; session: string; error: string }
  | { event: "autopilot"; session: string; kind: string };

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
