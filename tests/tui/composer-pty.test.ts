import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// End-to-end check of the prompt composer's interactive wiring: a real TUI process
// in a pseudo-terminal (so stdin/stdout are TTYs and raw mode works), driven by
// written keystrokes, talking to a minimal fake control server that records what
// it's asked to send. This is the part the unit-tested parser can't cover — that
// the raw-stdin + bracketed-paste path actually delivers a pasted multi-line block.

interface Sent {
  op: string;
  session?: string;
  text?: string;
}

// Some sandboxes block forkpty/posix_spawnp; skip there (the same keystroke path is
// also proven via a `script(1)` + fake-server check during development).
const ptyAvailable = ((): boolean => {
  try {
    spawn(process.execPath, ["-e", "0"], { cols: 80, rows: 24 }).kill();
    return true;
  } catch {
    return false;
  }
})();

// Skip on CI. This boots the whole CLI through tsx in a pty while the rest of the
// vitest suite runs in parallel workers; on a 2-core runner the cold transpile gets
// CPU-starved and the first paint is wildly variable — flaky even at a 60s budget,
// and unreproducible locally where it boots in ~1s. It runs for real in normal dev
// (where a pty exists and a human can validate it); the bracketed-paste PARSING it
// guards is also covered deterministically by the unit-tested parser.
const runPty = ptyAvailable && !process.env.CI;

/** A minimal protocol server: a canned session + peek, and it records `send`s. */
function fakeServer(sockPath: string, sent: Sent[]): net.Server {
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    const reply = (m: unknown): void => {
      conn.write(`${JSON.stringify(m)}\n`);
    };
    reply({ event: "hello", version: "test" });
    conn.on("data", (d: string) => {
      buf += d;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        const req = JSON.parse(line) as { id: number } & Sent;
        if (req.op === "snapshot") {
          reply({
            id: req.id,
            ok: true,
            data: {
              sessions: [
                {
                  session: "s1",
                  label: "s1",
                  kind: "claude",
                  running: true,
                  busy: false,
                  cumulativeBusyMs: 0,
                  uptimeMs: 0,
                  usage: null,
                },
              ],
              global: {
                botUptimeMs: 0,
                version: "test",
                sessionCount: 1,
                runningCount: 1,
                busyCount: 0,
                queueDepth: 0,
                adapters: { telegram: false, lark: false },
              },
            },
          });
        } else if (req.op === "peek") {
          reply({ id: req.id, ok: true, data: "PANE" });
        } else if (req.op === "send") {
          sent.push(req);
          reply({ id: req.id, ok: true, data: { status: "queued" } });
        } else {
          reply({ id: req.id, ok: true, data: null });
        }
      }
    });
  });
  server.listen(sockPath);
  return server;
}

describe("TUI prompt composer (pty, end-to-end)", () => {
  let dir: string;
  let server: net.Server;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-pty-"));
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!runPty)(
    "delivers a bracketed multi-line PASTE verbatim and sends it",
    async () => {
      const sent: Sent[] = [];
      server = fakeServer(join(dir, "control.sock"), sent);

      const term = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "tui"], {
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: { ...process.env, TCB_STATE_DIR: dir, TCB_LOG_QUIET: "1" },
      });
      let out = "";
      term.onData((d) => {
        out += d;
      });
      // Capture an early exit so a crash fails fast with the code/signal instead of
      // silently waiting out the whole timeout (an empty-output timeout is useless).
      let exited: { exitCode: number; signal?: number } | undefined;
      term.onExit((e) => {
        exited = e;
      });
      const waitFor = (pred: () => boolean, ms: number): Promise<void> =>
        new Promise((resolve, reject) => {
          const t0 = Date.now();
          const tick = (): void => {
            if (pred()) resolve();
            else if (exited)
              reject(
                new Error(
                  `tui exited early (code=${exited.exitCode} signal=${exited.signal ?? "-"}); output:\n${out.slice(-400)}`,
                ),
              );
            else if (Date.now() - t0 > ms)
              reject(new Error(`timeout after ${ms}ms; output:\n${out.slice(-400)}`));
            else setTimeout(tick, 50);
          };
          tick();
        });

      try {
        // Booting the CLI through tsx cold-transpiles the whole src graph; on a
        // loaded 2-core CI runner the first paint can take tens of seconds, so the
        // footer wait is generous (the empty-output failure was this budget too tight).
        await waitFor(() => out.includes("q quit"), 60000); // TUI rendered the footer
        term.write("i"); // open the composer
        await waitFor(() => out.includes("Prompt"), 15000);
        // A literal bracketed paste with an embedded newline, then Enter to send.
        term.write("\x1b[200~hello\nworld\x1b[201~");
        term.write("\r");
        await waitFor(() => sent.length > 0, 15000);
      } finally {
        term.kill();
      }

      expect(sent[0]).toMatchObject({ op: "send", session: "s1", text: "hello\nworld" });
    },
    120000,
  );
});
