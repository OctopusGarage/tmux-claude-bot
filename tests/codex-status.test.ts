import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexStatusReport } from "../src/core/agents/codex/codex-status.js";
import { setPathForSession } from "../src/core/projects/sessionPathMap.js";

const SESSION = "codex-test-sess";
const PROJECT_PATH = "/home/user/projects/demo";
const fixture = fs.readFileSync(join(__dirname, "fixtures/codex-rollout.jsonl"), "utf8");

/** Build a minimal deps stub with a configResolver whose resolveCodexHome returns the given value. */
function makeDeps(codexHome: string | null): Parameters<typeof buildCodexStatusReport>[0] {
  return {
    configResolver: {
      resolveConfigRoot: vi.fn(async () => "/cfg"),
      isClaudeRunning: vi.fn(async () => false),
      isCodexRunning: vi.fn(async () => false),
      invalidate: vi.fn(),
      resolveCodexHome: vi.fn(async () => codexHome),
    },
  } as never;
}

describe("buildCodexStatusReport", () => {
  let origStateDir: string | undefined;
  let origUiLang: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    origStateDir = process.env.TCB_STATE_DIR;
    origUiLang = process.env.TELEGRAM_UI_LANG;
    process.env.TELEGRAM_UI_LANG = "en";
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), "tcb-codex-status-"));
    process.env.TCB_STATE_DIR = tmpDir;
    // Register the session → project path mapping
    setPathForSession(SESSION, PROJECT_PATH);
  });

  afterEach(() => {
    if (origStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = origStateDir;
    if (origUiLang === undefined) delete process.env.TELEGRAM_UI_LANG;
    else process.env.TELEGRAM_UI_LANG = origUiLang;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns just the not-running line when stopped", async () => {
    const result = await buildCodexStatusReport(makeDeps(null), SESSION, "telegram", false);
    expect(result).toBe("🔴 Codex not running");
    expect(result).not.toContain("%");
  });

  it("returns the running line (no usage) when CODEX_HOME is null", async () => {
    const result = await buildCodexStatusReport(makeDeps(null), SESSION, "telegram", true);
    expect(result).toBe("🟢 Codex running");
  });

  it("returns running line + usage bars when a matching rollout exists", async () => {
    // Set up CODEX_HOME with the fixture rollout under sessions/2026/03/27/
    const codexHome = join(tmpDir, "codex-home");
    const rolloutDir = join(codexHome, "sessions", "2026", "03", "27");
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(join(rolloutDir, "rollout.jsonl"), fixture);

    // Use a now close to the current time so the snapshot stays fresh (the
    // rollout's updatedAt is set to Math.floor(Date.now()/1000) by readUsage
    // when no explicit now is supplied, so Date.now() keeps the delta small).
    const nowMs = Date.now();
    const result = await buildCodexStatusReport(
      makeDeps(codexHome),
      SESSION,
      "telegram",
      true,
      nowMs,
    );

    expect(result).toContain("🟢 Codex running");
    // The fixture has fiveHourPct=42 and sevenDayPct=7, so usage lines should appear
    expect(result).toContain("42%");
    expect(result).toContain("7%");
    expect(result).toContain("█");
  });

  it("adds the endpoint/auth line under the running line when auth.json exists", async () => {
    const codexHome = join(tmpDir, "codex-home-api");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));

    const result = await buildCodexStatusReport(makeDeps(codexHome), SESSION, "telegram", true);
    const lines = result.split("\n");
    expect(lines[0]).toBe("🟢 Codex running");
    expect(lines[1]).toBe("🔌 API · api.openai.com");
  });

  it("omits the endpoint line when auth.json is absent", async () => {
    const codexHome = join(tmpDir, "codex-home-noauth");
    fs.mkdirSync(codexHome, { recursive: true });
    const result = await buildCodexStatusReport(makeDeps(codexHome), SESSION, "telegram", true);
    expect(result).not.toContain("🔌");
  });
});
