import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string, logDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-ak-"));
  logDir = fs.mkdtempSync(join(os.tmpdir(), "tcb-aklog-"));
  process.env.TCB_STATE_DIR = dir;
  process.env.TCB_LOG_DIR = logDir;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  delete process.env.TCB_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });
});

function logText(): string {
  const f = fs.readdirSync(logDir).find((x) => x.endsWith(".jsonl"));
  return f ? fs.readFileSync(join(logDir, f), "utf8") : "";
}

describe("agent kind self-heal is logged", () => {
  it("logs the from->to transition when the live kind disagrees with stored", async () => {
    const { setAgentKind, resolveAgentKind } = await import("../src/core/agents/agentKindMap.js");
    setAgentKind("sess_h", "codex");
    await resolveAgentKind({ detectAgentKind: async () => "claude" }, "sess_h");
    const text = logText();
    expect(text).toMatch(/codex/);
    expect(text).toMatch(/claude/);
    expect(text).toMatch(/sess_h/); // session present (ambient or data)
  });
});
