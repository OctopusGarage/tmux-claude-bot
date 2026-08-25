import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  categorizeStatusLine,
  manualSnippet,
  runStatusInstall,
  scriptPath,
  statuslineScript,
} from "../src/core/infra/status-install.js";

// runStatusInstall reads which config dirs are in use by probing real processes;
// mock that boundary so the install logic itself can be driven deterministically.
const dirsInUse = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock("../src/core/agents/takeover-service.js", () => ({
  claudeConfigDirsInUse: () => Promise.resolve(dirsInUse.value),
}));

const OURS = "/state/status-snapshots/statusline.sh";

let hasShellTools = false;
try {
  execFileSync("bash", ["-c", "command -v jq >/dev/null && command -v date >/dev/null"]);
  hasShellTools = true;
} catch {
  /* jq/date absent — skip the run-the-script test */
}

describe("categorizeStatusLine", () => {
  it("is clean when no statusLine is set", () => {
    expect(categorizeStatusLine({}, OURS).state).toBe("clean");
    expect(categorizeStatusLine({ statusLine: {} }, OURS).state).toBe("clean");
    expect(categorizeStatusLine(null, OURS).state).toBe("clean");
  });

  it("is ours when the command is our script (standalone or wrap form)", () => {
    expect(categorizeStatusLine({ statusLine: { command: OURS } }, OURS).state).toBe("ours");
    expect(
      categorizeStatusLine({ statusLine: { command: `${OURS} /state/orig.cmd` } }, OURS).state,
    ).toBe("ours");
  });

  it("is foreign for someone else's command, and surfaces it", () => {
    const res = categorizeStatusLine({ statusLine: { command: "~/my-statusline.sh" } }, OURS);
    expect(res.state).toBe("foreign");
    expect(res.foreignCmd).toBe("~/my-statusline.sh");
  });
});

describe("statuslineScript / manualSnippet", () => {
  it("bakes the snapshot dir and writes keyed by session_id", () => {
    const s = statuslineScript("/state/status-snapshots");
    expect(s).toContain("/state/status-snapshots");
    expect(s).toContain(".session_id");
    expect(s).toContain("rate_limits.five_hour.used_percentage");
    expect(s.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("manual snippet carries the jq write without the status-line echo", () => {
    const snip = manualSnippet("/state/status-snapshots");
    expect(snip).toContain("jq -c");
    expect(snip).not.toContain("#!/usr/bin/env bash");
  });

  it.skipIf(!hasShellTools)(
    "renders a rich two-line statusline (ctx bar + session/weekly + reset) from real input",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "tcb-sl-"));
      const f = join(dir, "statusline.sh");
      writeFileSync(f, statuslineScript(dir), { mode: 0o755 });
      const input = JSON.stringify({
        model: { display_name: "Opus 4.8" },
        context_window: { used_percentage: 88 },
        rate_limits: {
          five_hour: { used_percentage: 98, resets_at: 1781503200 },
          seven_day: { used_percentage: 10, resets_at: 1782075600 },
        },
      });
      const out = execFileSync("bash", ["-c", `printf %s '${input}' | '${f}'`]).toString();
      expect(out).toContain("88% ctx");
      expect(out).toContain("session 98%");
      expect(out).toContain("weekly 10%");
      expect(out).toContain("(reset ");
      expect(out).toContain("█"); // progress bar rendered
    },
  );

  it.skipIf(!hasShellTools)("renders reset_at fallbacks for session and weekly windows", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-sl-"));
    const f = join(dir, "statusline.sh");
    writeFileSync(f, statuslineScript(dir), { mode: 0o755 });
    const input = JSON.stringify({
      model: { display_name: "Opus 4.8" },
      context_window: { used_percentage: 42 },
      rate_limits: {
        session: { used_percentage: 61, reset_at: 1781503200 },
        weekly: { used_percentage: 12, reset_at: 1782075600 },
      },
    });
    const out = execFileSync("bash", ["-c", `printf %s '${input}' | '${f}'`]).toString();
    expect(out).toContain("session 61%");
    expect(out).toContain("weekly 12%");
    expect(out).not.toContain("(reset ?)");
  });

  it.skipIf(!hasShellTools)("renders missing usage percentages as unknown, not zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-sl-"));
    const f = join(dir, "statusline.sh");
    writeFileSync(f, statuslineScript(dir), { mode: 0o755 });
    const input = JSON.stringify({
      model: { display_name: "Opus 4.8" },
      context_window: {},
      rate_limits: {},
    });

    const out = execFileSync("bash", ["-c", `printf %s '${input}' | '${f}'`]).toString();

    expect(out).toContain("?% ctx");
    expect(out).toContain("session ?%");
    expect(out).toContain("weekly ?%");
    expect(out).not.toContain("0% ctx");
    expect(out).not.toContain("session 0%");
    expect(out).not.toContain("weekly 0%");
  });
});

describe("runStatusInstall", () => {
  let stateDir: string;
  let origState: string | undefined;
  let origLang: string | undefined;

  /** Make a fake claude config dir with an optional settings.json. */
  function makeConfigDir(name: string, settings?: unknown): string {
    const dir = join(stateDir, name);
    mkdirSync(dir, { recursive: true });
    if (settings !== undefined) {
      writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
    }
    return dir;
  }

  const readSettings = (dir: string): { statusLine?: { command?: string } } =>
    JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

  beforeEach(() => {
    origState = process.env.TCB_STATE_DIR;
    origLang = process.env.UI_LANG;
    stateDir = mkdtempSync(join(tmpdir(), "tcb-statusinstall-"));
    process.env.TCB_STATE_DIR = stateDir;
    process.env.UI_LANG = "en"; // pin English copy so message assertions are stable
    dirsInUse.value = [];
  });

  afterEach(() => {
    if (origState === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = origState;
    if (origLang === undefined) delete process.env.UI_LANG;
    else process.env.UI_LANG = origLang;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reports no claude and writes nothing when no config dirs are in use", async () => {
    dirsInUse.value = [];
    const res = await runStatusInstall("telegram", "scan");
    expect(res.foreignPending).toBe(false);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatch(/no .*claude/i);
    // ensureScript() must not have run.
    expect(existsSync(scriptPath())).toBe(false);
  });

  it("installs into a clean dir (no settings.json) and writes our statusLine", async () => {
    const dir = makeConfigDir("clean-new");
    rmSync(join(dir, "x"), { force: true }); // dir exists, settings.json absent
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "scan");
    expect(res.foreignPending).toBe(false);
    expect(res.lines.some((l) => l.includes("installed"))).toBe(true);
    // The generated script and the dir's settings.json both exist now.
    expect(existsSync(scriptPath())).toBe(true);
    expect(readSettings(dir).statusLine?.command).toBe(scriptPath());
  });

  it("installs into a clean dir with existing settings, preserving other keys + backing up", async () => {
    const dir = makeConfigDir("clean-existing", { theme: "dark", model: "opus" });
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "scan");
    expect(res.lines.some((l) => l.includes("installed"))).toBe(true);
    const merged = readSettings(dir) as Record<string, unknown>;
    expect(merged.theme).toBe("dark");
    expect(merged.model).toBe("opus");
    expect((merged.statusLine as { command: string }).command).toBe(scriptPath());
    // A timestamped backup of the original settings was created.
    const backups = readdirSync(dir).filter((f) => f.startsWith("settings.json.bak."));
    expect(backups).toHaveLength(1);
  });

  it("skips a dir that already has our statusLine (idempotent), making no backup", async () => {
    const dir = makeConfigDir("ours", {
      statusLine: { type: "command", command: scriptPath() },
    });
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "scan");
    expect(res.foreignPending).toBe(false);
    expect(res.lines.some((l) => l.includes("already"))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes(".bak."))).toHaveLength(0);
  });

  it("on scan, surfaces foreign dirs as pending without modifying them", async () => {
    const foreignCmd = "~/my-statusline.sh";
    const dir = makeConfigDir("foreign", { statusLine: { type: "command", command: foreignCmd } });
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "scan");
    expect(res.foreignPending).toBe(true);
    expect(res.lines.some((l) => l.includes(dir))).toBe(true);
    // Untouched: still the foreign command, no backup written.
    expect(readSettings(dir).statusLine?.command).toBe(foreignCmd);
    expect(readdirSync(dir).filter((f) => f.includes(".bak."))).toHaveLength(0);
  });

  it("overwrite replaces the foreign command with ours and backs up", async () => {
    const dir = makeConfigDir("ovr", { statusLine: { type: "command", command: "~/old.sh" } });
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "overwrite");
    expect(res.foreignPending).toBe(false);
    expect(res.lines.some((l) => l.includes("overwritten"))).toBe(true);
    expect(readSettings(dir).statusLine?.command).toBe(scriptPath());
    expect(readdirSync(dir).filter((f) => f.startsWith("settings.json.bak."))).toHaveLength(1);
  });

  it("wrap writes a sidecar with the original cmd and points statusLine at script + sidecar", async () => {
    const foreignCmd = "~/original-statusline.sh --flag";
    const dir = makeConfigDir("wrap", {
      statusLine: { type: "command", command: foreignCmd },
    });
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "wrap");
    expect(res.lines.some((l) => l.includes("wrapped") || l.includes("Wrapped"))).toBe(true);
    const cmd = readSettings(dir).statusLine?.command ?? "";
    expect(cmd.startsWith(`${scriptPath()} `)).toBe(true);
    // The sidecar referenced in the command holds the original command verbatim.
    const sidecar = cmd.slice(scriptPath().length + 1);
    expect(readFileSync(sidecar, "utf8")).toBe(foreignCmd);
  });

  it("wrap preserves other statusLine fields (e.g. refreshInterval)", async () => {
    const dir = makeConfigDir("wrap-keep", {
      statusLine: { type: "command", command: "~/mine.sh", refreshInterval: 60 },
    });
    dirsInUse.value = [dir];
    await runStatusInstall("telegram", "wrap");
    const sl = readSettings(dir).statusLine as { command?: string; refreshInterval?: number };
    expect(sl.command?.startsWith(`${scriptPath()} `)).toBe(true);
    expect(sl.refreshInterval).toBe(60);
  });

  it("snippet leaves settings untouched and returns the paste-in jq block", async () => {
    const foreignCmd = "~/mine.sh";
    const dir = makeConfigDir("snip", { statusLine: { type: "command", command: foreignCmd } });
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "snippet");
    expect(res.lines.some((l) => l.includes("jq -c"))).toBe(true);
    // Settings unchanged — snippet is manual.
    expect(readSettings(dir).statusLine?.command).toBe(foreignCmd);
  });

  it("skip leaves the foreign dir untouched and reports it skipped", async () => {
    const foreignCmd = "~/mine.sh";
    const dir = makeConfigDir("skp", { statusLine: { type: "command", command: foreignCmd } });
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "skip");
    expect(res.lines.some((l) => l.includes("skipped"))).toBe(true);
    expect(readSettings(dir).statusLine?.command).toBe(foreignCmd);
  });

  it("reports a per-dir error when installing into a clean dir fails", async () => {
    // Point at a path whose parent is a FILE, so mkdirSync(dir) throws (ENOTDIR).
    const blocker = join(stateDir, "not-a-dir");
    writeFileSync(blocker, "x");
    const dir = join(blocker, "child");
    dirsInUse.value = [dir];
    const res = await runStatusInstall("telegram", "scan");
    expect(res.foreignPending).toBe(false);
    expect(res.lines.some((l) => l.includes(dir) && l.includes("❌"))).toBe(true);
  });

  it("handles a mix of clean, ours, and foreign dirs in one pass", async () => {
    const clean = makeConfigDir("mix-clean", {});
    const ours = makeConfigDir("mix-ours", {
      statusLine: { type: "command", command: scriptPath() },
    });
    const foreign = makeConfigDir("mix-foreign", {
      statusLine: { type: "command", command: "~/f.sh" },
    });
    dirsInUse.value = [clean, ours, foreign];
    const res = await runStatusInstall("telegram", "scan");
    expect(res.foreignPending).toBe(true);
    expect(res.lines.some((l) => l.includes(clean) && l.includes("installed"))).toBe(true);
    expect(res.lines.some((l) => l.includes(ours) && l.includes("already"))).toBe(true);
    expect(res.lines.some((l) => l.includes(foreign))).toBe(true);
  });
});
