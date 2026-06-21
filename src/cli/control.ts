import { ControlClient } from "../adapters/control/client.js";
import type { SessionRow } from "../core/dashboard/dashboard.js";

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
    if (opts.wait === false) {
      const ack = await c.send(session, text);
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
    await c.send(session, text);
    const output = await reply;
    if (opts.json) return json({ session, reply: output });
    out(output);
  }).catch(fail);
}

export async function cmdOpen(ref: string, opts: { json?: boolean }): Promise<void> {
  await withClient(async (c) => {
    const sid = await resolveProjectSid(c, ref);
    const res = await c.open(sid);
    if (opts.json) return json(res);
    out(`open ${ref}: ${res.status}${res.started ? ` (${res.started})` : ""}`);
  }).catch(fail);
}

export async function cmdControl(
  ref: string,
  action: string,
  opts: { json?: boolean },
): Promise<void> {
  await withClient(async (c) => {
    const session = await resolveSession(c, ref);
    const ack = await c.control(session, action);
    if (opts.json) return json({ session, action, ...ack });
    out(`${action} → ${ref}: ${ack.status}`);
  }).catch(fail);
}
