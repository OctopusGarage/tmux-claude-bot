import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { vi } from "vitest";
import type { QueuedMessage } from "../../../src/core/command/queue.js";
import type { HandlerDeps } from "../../../src/core/deps.js";

/**
 * Shared fakes for the Lark adapter orchestration tests. They record observable
 * outputs (channel sends, queue enqueues) so tests assert behavior — which
 * payloads went out, which actions were enqueued — not implementation details.
 *
 * `sendText`/`sendCard` in replies.ts both call `channel.send`, so recording
 * `send` is enough: inspect `input` (`{ markdown }` vs `{ card }`) to tell a
 * plain-text reply from a card reply.
 */

export type SentRecord = {
  chatId: string;
  input: unknown;
  opts?: unknown;
};

export type FakeChannel = LarkChannel & {
  sent: SentRecord[];
  reactions: { messageId: string; emoji: string }[];
  removedReactions: { messageId: string; emoji: string }[];
  /** Text of every `{ markdown }` send, for quick assertions. */
  texts: () => string[];
  /** The `card` object of every `{ card }` send. */
  cards: () => unknown[];
  /** Test helper: set what getChatInfo reports (defaults to "p2p"). */
  setChatType: (t: "p2p" | "group") => void;
};

export function fakeChannel(): FakeChannel {
  const sent: SentRecord[] = [];
  const reactions: { messageId: string; emoji: string }[] = [];
  const removedReactions: { messageId: string; emoji: string }[] = [];
  let n = 0;
  let chatType: "p2p" | "group" = "p2p";

  const channel = {
    sent,
    reactions,
    removedReactions,
    texts: () =>
      sent
        .map((s) => (s.input as { markdown?: string }).markdown)
        .filter((m): m is string => typeof m === "string"),
    cards: () =>
      sent.map((s) => (s.input as { card?: unknown }).card).filter((c) => c !== undefined),
    send: vi.fn(async (chatId: string, input: unknown, opts?: unknown) => {
      sent.push({ chatId, input, opts });
      n += 1;
      return { messageId: `m${n}` };
    }),
    addReaction: vi.fn(async (messageId: string, emoji: string) => {
      reactions.push({ messageId, emoji });
    }),
    removeReactionByEmoji: vi.fn(async (messageId: string, emoji: string) => {
      removedReactions.push({ messageId, emoji });
    }),
    downloadResource: vi.fn(async (_fileKey: string, _type: string) => Buffer.from("fake-audio")),
    getChatInfo: vi.fn(async (chatId: string) => ({ chatId, chatType })),
    setChatType: (t: "p2p" | "group") => {
      chatType = t;
    },
  };

  return channel as unknown as FakeChannel;
}

/**
 * A minimal in-memory queue fake. Records each enqueued message and lets a test
 * drive its `resolve`/`reject` to exercise the result-card path. `size`,
 * `getMaxSize` and friends are configurable via overrides.
 */
export type FakeQueue = HandlerDeps["queue"] & {
  enqueued: QueuedMessage[];
  /** Resolve the last enqueued message's `resolve` callback. */
  resolveLast: (output: string) => void;
  /** Reject the last enqueued message's `reject` callback. */
  rejectLast: (err: Error) => void;
};

type DepsOverrides = {
  config?: Partial<HandlerDeps["config"]>;
  currentProject?: Partial<HandlerDeps["currentProject"]>;
  queue?: Partial<HandlerDeps["queue"]>;
  bridge?: Partial<HandlerDeps["bridge"]>;
  agent?: Partial<HandlerDeps["agent"]>;
  output?: Partial<HandlerDeps["output"]>;
  configResolver?: Partial<HandlerDeps["configResolver"]>;
  activity?: Partial<HandlerDeps["activity"]>;
  /** Override the default current session ("proj-1"); pass null for "none". */
  session?: string | null;
  /** Override the default allowed open ids (default {"ou_me"}). */
  allowedOpenIds?: Set<string>;
  /** Make queue.enqueue return undefined (queue full). */
  queueFull?: boolean;
  /** queue.size() return value (default 0). */
  queueSize?: number;
};

export type FakeDeps = HandlerDeps & { queue: FakeQueue };

export function fakeDeps(overrides: DepsOverrides = {}): FakeDeps {
  const session = overrides.session === undefined ? "proj-1" : overrides.session;
  const allowedOpenIds = overrides.allowedOpenIds ?? new Set(["ou_me"]);

  const enqueued: QueuedMessage[] = [];
  const queue = {
    enqueued,
    resolveLast: (output: string) => {
      const last = enqueued[enqueued.length - 1];
      if (last) last.resolve(output);
    },
    rejectLast: (err: Error) => {
      const last = enqueued[enqueued.length - 1];
      if (last) last.reject(err);
    },
    enqueue: vi.fn((msg: QueuedMessage) => {
      enqueued.push(msg);
      return overrides.queueFull ? false : "queued";
    }),
    size: vi.fn(() => overrides.queueSize ?? 0),
    getMaxSize: vi.fn(() => 30),
    isSessionProcessing: vi.fn(() => false),
    getSessionQueue: vi.fn(() => [] as QueuedMessage[]),
    getCurrentSessionMessage: vi.fn(() => undefined),
    getGlobalQueue: vi.fn(() => [] as QueuedMessage[]),
    isGlobalProcessing: vi.fn(() => false),
    getCurrentGlobalMessage: vi.fn(() => undefined),
    getSessionNames: vi.fn(() => [] as string[]),
    getLastProcessedAt: vi.fn(() => undefined),
    clearSession: vi.fn(),
    ...overrides.queue,
  } as unknown as FakeQueue;

  const currentProject = {
    get: vi.fn(async (_channel?: string) => session),
    set: vi.fn(async (_channel?: string, _s?: string) => {}),
    clear: vi.fn(async (_channel?: string) => {}),
    clearSession: vi.fn(async (_s?: string) => {}),
    getAny: vi.fn(async () => session),
    allCurrent: vi.fn(async () => (session ? [session] : [])),
    ...overrides.currentProject,
  } as unknown as HandlerDeps["currentProject"];

  const bridge = {
    capturePane: vi.fn(async () => "PANE"),
    listProjectSessions: vi.fn(async () => [] as string[]),
    sessionsCreatedAt: vi.fn(async () => new Map<string, number>()),
    hasSession: vi.fn(async () => false),
    createSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    sendKeys: vi.fn(async () => {}),
    sendExit: vi.fn(async () => {}),
    sendRawKey: vi.fn(async () => {}),
    paneCurrentPath: vi.fn(async () => null),
    ...overrides.bridge,
  } as unknown as HandlerDeps["bridge"];

  const agent = {
    checkIfRunning: vi.fn(async () => true),
    waitUntilDone: vi.fn(async () => ({ done: true, output: "done" })),
    start: vi.fn(async () => {}),
    ...overrides.agent,
  } as unknown as HandlerDeps["agent"];

  const output = {
    process: vi.fn((s: string) => s),
    ...overrides.output,
  } as unknown as HandlerDeps["output"];

  const configResolver = {
    resolveConfigRoot: vi.fn(async () => "/tmp/cfg"),
    invalidate: vi.fn(),
    ...overrides.configResolver,
  } as unknown as HandlerDeps["configResolver"];

  const config = {
    cdAllowedDirs: ["/home/user"],
    projectSessionPrefix: "tmux_proj_",
    sessionWarmupMs: 0,
    maxQueueSize: 30,
    claudeStartCommand: "bash",
    startCommands: [{ label: "claude", command: "bash" }],
    lark: { allowedOpenIds },
    ...overrides.config,
  } as unknown as HandlerDeps["config"];

  const activity = {
    isActiveWithin: () => false,
    onActivity: () => () => {},
    start: () => {},
    stop: () => {},
    ...overrides.activity,
  } as unknown as HandlerDeps["activity"];

  return {
    bridge,
    queue,
    agent,
    output,
    config,
    currentProject,
    configResolver,
    activity,
  } as FakeDeps;
}

/** Build a NormalizedMessage with sensible p2p text defaults. */
export function fakeMessage(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "msg-1",
    chatId: "chat-1",
    chatType: "p2p",
    senderId: "ou_me",
    content: "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    ...over,
  } as NormalizedMessage;
}
