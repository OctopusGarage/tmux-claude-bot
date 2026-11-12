import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Vitest owns this root outside test workers. Its teardown still runs when a
// test file cannot import or a file-level cleanup hook fails or times out.
export default function setup() {
  const original = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  // macOS Unix sockets cannot fit beneath its long per-user TMPDIR. mkdtemp
  // creates a private owned directory; Windows retains its platform temp root.
  const parent = process.platform === "win32" ? tmpdir() : "/tmp";
  const root = realpathSync(mkdtempSync(join(parent, "tcb-")));
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      process.removeListener("exit", cleanup);
    }
  };
  // Vitest's SIGINT path can exit before global teardown. This exact-root
  // synchronous fallback is removed on ordinary teardown; SIGKILL cannot run it.
  process.once("exit", cleanup);
  return cleanup;
}
