import { execFile } from "node:child_process";

/** Injectable dependencies (defaulted to the real OS in production). */
export interface ClipboardDeps {
  /** Run `cmd args`, writing `input` to its stdin. Rejects if cmd is missing. */
  runWith(cmd: string, args: string[], input: string): Promise<void>;
  /** Whether `cmd` is resolvable on PATH. */
  onPath(cmd: string): Promise<boolean>;
  platform: string;
  env: Record<string, string | undefined>;
}

function spawnWith(cmd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(input);
  });
}

const realDeps: ClipboardDeps = {
  runWith: spawnWith,
  onPath: (cmd) =>
    new Promise((resolve) => {
      // cmd is always a hardcoded literal from the candidate list below (never
      // user input), so interpolating it into the shell command is safe. Passing
      // it via `sh -c` avoids Node's DEP0190 (args array + shell) deprecation.
      execFile("/bin/sh", ["-c", `command -v "${cmd}"`], (err) => resolve(!err));
    }),
  platform: process.platform,
  env: process.env,
};

/** Copy text to the system clipboard. Returns false when no clipboard tool is
 * available (e.g. a headless Linux server) — callers should treat that as a
 * soft "couldn't copy", not an error. */
export async function copyToClipboard(
  text: string,
  deps: ClipboardDeps = realDeps,
): Promise<boolean> {
  // `when` gates each tool on its display server being present: invoking a GUI
  // clipboard (wl-copy/xclip) with no WAYLAND_DISPLAY/DISPLAY can fail or block,
  // so we skip it rather than rely on onPath alone. xsel is the last-resort try.
  const candidates: { cmd: string; args: string[]; when: boolean }[] =
    deps.platform === "darwin"
      ? [{ cmd: "pbcopy", args: [], when: true }]
      : [
          { cmd: "wl-copy", args: [], when: Boolean(deps.env.WAYLAND_DISPLAY) },
          { cmd: "xclip", args: ["-selection", "clipboard"], when: Boolean(deps.env.DISPLAY) },
          { cmd: "xsel", args: ["--clipboard", "--input"], when: true },
        ];

  for (const c of candidates) {
    if (!c.when) continue;
    if (!(await deps.onPath(c.cmd))) continue;
    try {
      await deps.runWith(c.cmd, c.args, text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
