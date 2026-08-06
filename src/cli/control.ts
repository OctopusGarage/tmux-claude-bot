import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ControlClient } from "../adapters/control/client.js";
import { requiresActionConfirmation } from "../core/command/action-registry.js";
import type { SessionRow } from "../core/dashboard/dashboard.js";
import type {
  NotificationChannelSelection,
  NotificationLevel,
  NotificationRequest,
} from "../core/notifications/gateway.js";
import type { AgentKind } from "../shared/types.js";
import { expandTilde } from "../shared/utils/path.js";

/**
 * One-shot CLI clients of the bot's control socket — so an AI agent (or a script)
 * can drive the bot from the shell without the TUI or a chat app: connect, do one
 * thing, print, exit. Every mutation still funnels through the bot's single queue
 * (it's the same transport the TUI uses), so the CLI can't race the other clients.
 */

const NOT_RUNNING =
  "Can't reach the bot's control socket — is it running?  start it: tcb service start\n";

async function withClient<T>(fn: (c: ControlClient) => Promise<T>): Promise<T> {
  const c = new ControlClient();
  try {
    await c.connect();
  } catch {
    process.stderr.write(NOT_RUNNING);
    process.exit(1);
  }
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

const label = (s: SessionRow): string => s.label || s.session;
const lc = (s: string): string => s.toLowerCase();

/**
 * Resolve a user/AI-given ref to exactly one item: an exact key/label match, else a
 * UNIQUE label substring. Throws a clear message on ambiguity or no match — so an AI
 * types `geo` not `tmux_proj_-Users-…`. Pure + unit-tested.
 */
export function matchRef<T>(
  items: T[],
  ref: string,
  keyOf: (t: T) => string,
  labelOf: (t: T) => string,
  noun: string,
  listCmd: string,
): T {
  const exact = items.find((t) => keyOf(t) === ref || lc(labelOf(t)) === lc(ref));
  if (exact) return exact;
  const subs = items.filter((t) => lc(labelOf(t)).includes(lc(ref)));
  if (subs.length === 1) return subs[0] as T;
  if (subs.length > 1)
    throw new Error(`ambiguous "${ref}" — matches: ${subs.map(labelOf).join(", ")}`);
  throw new Error(`no ${noun} matches "${ref}". List them: ${listCmd}`);
}

async function resolveSession(c: ControlClient, ref: string): Promise<string> {
  const { sessions } = await c.snapshot();
  return matchRef(sessions, ref, (s) => s.session, label, "running session", "tcb sessions")
    .session;
}

async function resolveProjectSid(c: ControlClient, ref: string): Promise<string> {
  const projects = await c.projects();
  return matchRef(
    projects,
    ref,
    (p) => p.sid,
    (p) => p.label,
    "project",
    "tcb projects",
  ).sid;
}

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));
const fail = (err: unknown): never => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
};

const NOTIFY_CHANNELS = new Set(["telegram", "lark", "both"]);
const NOTIFY_LEVELS = new Set(["info", "success", "warning", "error"]);
const AGENT_KINDS = new Set(["claude", "codex"]);

type NotifyCliOpts = {
  title?: string;
  body?: string;
  channel?: string;
  level?: string;
  source?: string;
  session?: string;
  attach?: string[];
  stdin?: boolean;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function buildNotifyRequest(
  words: string[],
  opts: NotifyCliOpts,
  stdinReader: () => Promise<string> = readStdin,
): Promise<NotificationRequest> {
  if (opts.channel !== undefined && !NOTIFY_CHANNELS.has(opts.channel)) {
    throw new Error("channel must be one of: telegram, lark, both");
  }
  if (opts.level !== undefined && !NOTIFY_LEVELS.has(opts.level)) {
    throw new Error("level must be one of: info, success, warning, error");
  }
  const positional = words.join(" ").trim();
  const title = (opts.title ?? positional).trim();
  if (!title) throw new Error("notification requires --title or positional text");
  const stdinBody = opts.stdin ? (await stdinReader()).trimEnd() : undefined;
  const body = opts.body ?? stdinBody;
  return {
    title,
    ...(body !== undefined && body.length > 0 ? { body } : {}),
    ...(opts.channel !== undefined
      ? { channel: opts.channel as NotificationChannelSelection }
      : {}),
    ...(opts.level !== undefined ? { level: opts.level as NotificationLevel } : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.session !== undefined ? { session: opts.session } : {}),
    ...(opts.attach !== undefined && opts.attach.length > 0
      ? {
          attachments: opts.attach.map((path) => ({
            path: resolve(process.cwd(), expandTilde(path)),
          })),
        }
      : {}),
  };
}

export async function confirmCliDangerousControl(
  action: string,
  target: string,
  opts: {
    yes?: boolean;
    isTty?: boolean;
    ask?: (question: string) => Promise<string>;
  } = {},
): Promise<boolean> {
  if (!requiresActionConfirmation(action)) return true;
  if (opts.yes) return true;
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY);
  if (!isTty) throw new Error(`"${action}" requires --yes in non-interactive mode`);
  const ask =
    opts.ask ??
    (async (question: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    });
  const answer = (await ask(`Confirm ${action} for ${target}? Type yes to continue: `)).trim();
  return answer === "yes";
}

export async function cmdSessions(opts: { json?: boolean }): Promise<void> {
  await withClient(async (c) => {
    const { sessions } = await c.snapshot();
    if (opts.json) return json(sessions);
    if (sessions.length === 0) return out("(no sessions)");
    for (const s of sessions) out(`${s.busy ? "●" : "○"} ${label(s)}  [${s.kind}]`);
  }).catch(fail);
}

export async function cmdProjects(opts: { json?: boolean }): Promise<void> {
  await withClient(async (c) => {
    const projects = await c.projects();
    if (opts.json) return json(projects);
    for (const p of projects) out(`${p.alive ? "●" : "◌"} ${p.label}${p.active ? " *" : ""}`);
  }).catch(fail);
}

export async function cmdPeek(
  ref: string,
  opts: { lines?: string; json?: boolean },
): Promise<void> {
  await withClient(async (c) => {
    const session = await resolveSession(c, ref);
    const text = await c.peek(session, opts.lines ? Number.parseInt(opts.lines, 10) : 40);
    if (opts.json) return json({ session, peek: text });
    out(text);
  }).catch(fail);
}

export async function cmdSend(
  ref: string,
  words: string[],
  opts: { wait?: boolean; timeout?: string; json?: boolean },
): Promise<void> {
  const text = words.join(" ");
  const timeoutMs = (opts.timeout ? Number.parseInt(opts.timeout, 10) : 120) * 1000;
  await withClient(async (c) => {
    const session = await resolveSession(c, ref);
    // No-wait: ack and return. Wait (default): block for the reply event (or timeout).
    const callerSession = currentTmuxSession();
    if (opts.wait === false) {
      const ack = await c.send(session, text, callerSession ? { callerSession } : {});
      return opts.json ? json({ session, ...ack }) : out(`queued → ${ref}`);
    }
    const reply = new Promise<string>((resolve, reject) => {
      const onReply = (m: { session: string; output: string }): void => {
        if (m.session !== session) return;
        done();
        resolve(m.output);
      };
      const onErr = (m: { session: string; error: string }): void => {
        if (m.session !== session) return;
        done();
        reject(new Error(m.error));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out after ${timeoutMs / 1000}s waiting for a reply`));
      }, timeoutMs);
      const done = (): void => {
        c.off("reply", onReply);
        c.off("error", onErr);
        clearTimeout(timer);
      };
      c.on("reply", onReply);
      c.on("error", onErr);
    });
    await c.send(session, text, callerSession ? { callerSession } : {});
    const output = await reply;
    if (opts.json) return json({ session, reply: output });
    out(output);
  }).catch(fail);
}

function parseAgentOption(opts: { agent?: string }): AgentKind | undefined {
  if (opts.agent === undefined) return undefined;
  if (!AGENT_KINDS.has(opts.agent)) {
    throw new Error("--agent must be one of: claude, codex");
  }
  return opts.agent as AgentKind;
}

export async function cmdOpen(
  ref: string,
  opts: { json?: boolean; agent?: string },
): Promise<void> {
  await withClient(async (c) => {
    const agent = parseAgentOption(opts);
    const openOpts = agent === undefined ? {} : { agent };
    // A known (live/recent) project by name or short-id → switch / start it.
    const sid = await resolveProjectSid(c, ref).then(
      (s) => s,
      () => null,
    );
    if (sid) {
      const res = await c.open(sid, openOpts);
      if (opts.json) return json(res);
      out(`open ${ref}: ${res.status}${res.started ? ` (${res.started})` : ""}`);
      return;
    }
    // Otherwise treat ref as a filesystem path (~, relative, or absolute) and
    // create the project there — parity with the chat /add_project flow. Resolve
    // against the SHELL cwd here: the bot would resolve a relative path against
    // its own working dir, not the user's.
    const abs = resolve(process.cwd(), expandTilde(ref));
    const res = await c.openPath(abs, openOpts);
    if (opts.json) return json(res);
    if (res.status === "created" || res.status === "switched") {
      out(`open ${ref}: ${res.status}${res.started ? ` (${res.started})` : ""}`);
    } else if (res.status === "invalid") {
      fail(new Error(`cannot open "${ref}": ${res.error} (${res.resolvedPath})`));
    } else {
      fail(new Error(res.message ?? `open failed: ${res.status}`));
    }
  }).catch(fail);
}

export async function cmdOpenWorker(
  session: string,
  projectPath: string,
  opts: { json?: boolean; agent?: string },
): Promise<void> {
  await withClient(async (c) => {
    const agent = parseAgentOption(opts);
    const openOpts = agent === undefined ? {} : { agent };
    const abs = resolve(process.cwd(), expandTilde(projectPath));
    const res = await c.openWorker(session, abs, openOpts);
    if (opts.json) return json(res);
    if (res.status === "created" || res.status === "switched") {
      out(`open-worker ${session}: ${res.status}${res.started ? ` (${res.started})` : ""}`);
    } else if (res.status === "invalid") {
      fail(new Error(`cannot open worker at "${projectPath}": ${res.error} (${res.resolvedPath})`));
    } else {
      fail(new Error(res.message ?? `open-worker failed: ${res.status}`));
    }
  }).catch(fail);
}

/** List unmanaged claude/codex processes, or adopt one by PID (stop it, then
 * resume it under a managed session). Mirrors the chat /adopt flow. */
export async function cmdAdopt(pid: string | undefined, opts: { json?: boolean }): Promise<void> {
  await withClient(async (c) => {
    if (pid === undefined) {
      const orphans = await c.orphans();
      if (opts.json) return json(orphans);
      if (orphans.length === 0) {
        out("no adoptable unmanaged claude/codex processes");
        return;
      }
      for (const o of orphans) out(`${o.pid}\t${o.label}`);
      out("\nadopt one: tcb adopt <pid>");
      return;
    }
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) {
      fail(new Error(`invalid pid: ${pid}`));
      return;
    }
    const res = await c.adopt(n);
    if (opts.json) return json(res);
    out(res.body);
    if (!res.ok) process.exitCode = 1;
  }).catch(fail);
}

export async function cmdControl(
  ref: string,
  action: string,
  opts: { json?: boolean; yes?: boolean },
): Promise<void> {
  await withClient(async (c) => {
    const session = await resolveSession(c, ref);
    if (!(await confirmCliDangerousControl(action, ref, opts))) {
      if (opts.json) return json({ session, action, status: "cancelled" });
      out(`${action} → ${ref}: cancelled`);
      return;
    }
    const ack = await c.control(session, action);
    if (opts.json) return json({ session, action, ...ack });
    out(`${action} → ${ref}: ${ack.status}`);
  }).catch(fail);
}

export async function cmdNotify(
  words: string[],
  opts: NotifyCliOpts & { json?: boolean },
): Promise<void> {
  await withClient(async (c) => {
    const request = await buildNotifyRequest(words, opts);
    const result = await c.notify(request);
    if (opts.json) return json(result);
    const delivered = result.deliveries
      .map((d) => `${d.channel}:${d.ok ? "ok" : d.error}`)
      .join(" ");
    out(`notify: ${result.status}${delivered ? ` (${delivered})` : ""}`);
    if (result.status === "failed") process.exitCode = 1;
  }).catch(fail);
}

export async function cmdTaskAudit(opts: {
  now?: string;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
  await withClient(async (c) => {
    const now = opts.now === undefined ? undefined : parseCliTime(opts.now, "--now");
    const result = await c.taskAudit({
      ...(now !== undefined ? { now } : {}),
      force: opts.force ?? false,
    });
    if (opts.json) return json(result);
    if (result.fired) {
      out(
        `task audit fired: scheduledAt=${new Date(result.scheduledAt).toISOString()} failures=${result.failures}`,
      );
    } else {
      out(`task audit not fired: ${result.reason}`);
    }
  }).catch(fail);
}

function parseCliTime(value: string, flag: string): number {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`invalid ${flag} "${value}"`);
  return parsed;
}

export function currentTmuxSession(
  run: () => string = () =>
    execFileSync("tmux", ["display-message", "-p", "#S"], { encoding: "utf8" }),
): string | null {
  try {
    const s = run().trim();
    return s || null;
  } catch {
    return null;
  }
}

export async function cmdSendAttachment(
  files: string[],
  opts: { to?: string; caption?: string; json?: boolean },
): Promise<void> {
  await withClient(async (c) => {
    const session = opts.to ? await resolveSession(c, opts.to) : currentTmuxSession();
    if (!session) {
      fail("no current session context and no --to given");
      return;
    }
    const results: Array<{ file: string; status: string }> = [];
    let i = 0;
    for (const file of files) {
      const ack = await c.sendAttachment(session, file, i === 0 ? opts.caption : undefined);
      results.push({ file, status: ack.status });
      i++;
    }
    if (opts.json) return json({ session, results });
    out(results.map((r) => `${r.status} → ${r.file}`).join("\n"));
  }).catch(fail);
}

export async function cmdPromptTranslate(words: string[], opts: { json?: boolean }): Promise<void> {
  await withClient(async (c) => {
    const res = await c.promptTranslate(words.join(" "));
    if (opts.json) return json(res.status);
    out(res.body);
  }).catch(fail);
}

/** Delegate a session's current work to the Loop Supervisor. */
export async function cmdAutopilot(
  ref: string,
  verbParts: string[],
  opts: { json?: boolean },
): Promise<void> {
  await withClient(async (c) => {
    const session = await resolveSession(c, ref);
    const verb = verbParts.join(" ").trim();
    const res = await c.autopilot(session, verb);
    if (opts.json) return json(res);
    out(res.status);
  }).catch(fail);
}
