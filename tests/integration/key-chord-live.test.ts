import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parseKeyChord } from "../../src/core/command/key-chord.js";
import { TmuxBridge } from "../../src/core/session/tmux.js";

function available(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    if (command !== "tmux") return false;
    try {
      execFileSync(command, ["-V"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

it.skipIf(!available("tmux") || !available("python3"))(
  "delivers distinct modifier bytes through the real bridge on an isolated tmux server",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-key-chords-"));
    const socket = `tcb-keys-${process.pid}-${Date.now()}`;
    const script = join(root, "capture.py");
    const captured = join(root, "bytes");
    writeFileSync(
      script,
      [
        "import os, sys, tty",
        "tty.setraw(0)",
        "with open(sys.argv[1], 'wb', buffering=0) as output:",
        "    while True:",
        "        output.write(os.read(0, 1024))",
      ].join("\n"),
    );
    const run = promisify(execFile);
    const bridge = new TmuxBridge({
      getSessionName: async () => "keys",
      execFile: (file, args, options) =>
        run(file, ["-L", socket, ...args], { timeout: options?.timeout }),
    });
    try {
      execFileSync("tmux", [
        "-L",
        socket,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "keys",
        "python3",
        script,
        captured,
      ]);
      await expect.poll(() => existsSync(captured), { timeout: 5000 }).toBe(true);
      let expected = "";
      for (const [input, bytes] of [
        ["Shift+Left", "\u001b[1;2D"],
        ["Ctrl+Left", "\u001b[1;5D"],
        ["Alt+B", "\u001bb"],
        ["Shift+Tab", "\u001b[Z"],
      ] as const) {
        const chord = parseKeyChord(input);
        if (!chord) throw new Error(`Invalid test chord: ${input}`);
        await bridge.sendRawKey(chord.tmuxKey, "keys");
        expected += bytes;
        await expect.poll(() => readFileSync(captured, "utf8"), { timeout: 5000 }).toBe(expected);
      }
    } finally {
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
