import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findRolloutForProject,
  matchNewestOpenCodexRollout,
  matchOpenCodexRollout,
  readCodexModelFromRollout,
} from "../src/core/agents/codex/codex-rollout.js";

const CWD = "/home/user/projects/demo";

/** Write a rollout JSONL (session_meta first line) and force its mtime. */
function writeRollout(
  dir: string,
  name: string,
  id: string,
  cwd: string,
  mtimeSec: number,
): string {
  const p = join(dir, name);
  const meta = JSON.stringify({ type: "session_meta", payload: { id, cwd } });
  const body = `${meta}\n${'{"type":"event_msg","payload":{"type":"token_count"}}\n'.repeat(50)}`;
  fs.writeFileSync(p, body);
  fs.utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

describe("matchOpenCodexRollout", () => {
  it("returns the open rollout .jsonl (path + uuid) from a pid's open files", () => {
    const files = [
      "/dev/null",
      "/Users/x/.codex/sessions/2026/03/27/rollout-2026-03-27T10-00-00-11111111-2222-3333-4444-555555555555.jsonl",
      "/tmp/socket",
    ];
    expect(matchOpenCodexRollout(files)).toEqual({
      path: files[1],
      sessionId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("returns null when no open file is a sessions rollout", () => {
    expect(matchOpenCodexRollout(["/dev/null", "/home/user/projects/demo/notes.jsonl"])).toBeNull();
  });

  it("returns the newest-mtime rollout when a live codex pid keeps several rollouts open", async () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), "codex-open-rollout-"));
    const dir = join(home, "sessions", "2026", "03", "27");
    fs.mkdirSync(dir, { recursive: true });
    const stale = writeRollout(
      dir,
      "rollout-2026-03-27T10-00-00-11111111-2222-3333-4444-555555555555.jsonl",
      "11111111-2222-3333-4444-555555555555",
      CWD,
      1_000_000,
    );
    const current = writeRollout(
      dir,
      "rollout-2026-03-27T11-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      CWD,
      2_000_000,
    );

    try {
      await expect(matchNewestOpenCodexRollout(["/dev/null", stale, current])).resolves.toEqual({
        path: current,
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("findRolloutForProject", () => {
  let home: string;
  let dir: string;
  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "codex-rollout-"));
    dir = join(home, "sessions", "2026", "03", "27");
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it("returns the newest-mtime rollout among several sharing the cwd", async () => {
    writeRollout(dir, "old.jsonl", "old-id", CWD, 1_000_000);
    writeRollout(dir, "new.jsonl", "new-id", CWD, 2_000_000);
    expect((await findRolloutForProject(home, CWD))?.sessionId).toBe("new-id");
  });

  it("ignores rollouts whose cwd does not match", async () => {
    writeRollout(dir, "other.jsonl", "other-id", "/somewhere/else", 9_000_000);
    writeRollout(dir, "mine.jsonl", "mine-id", CWD, 1_000_000);
    const match = await findRolloutForProject(home, CWD);
    expect(match?.sessionId).toBe("mine-id");
    expect(match?.path).toContain("mine.jsonl");
  });

  it("returns null when no rollout matches", async () => {
    writeRollout(dir, "x.jsonl", "x", "/nope", 1_000_000);
    expect(await findRolloutForProject(home, CWD)).toBeNull();
  });
});

describe("readCodexModelFromRollout", () => {
  it("reads the last recorded model from the rollout turn context", async () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), "codex-rollout-model-"));
    const path = join(home, "rollout.jsonl");
    fs.writeFileSync(
      path,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "sid", cwd: CWD } }),
        JSON.stringify({
          type: "turn_context",
          payload: { cwd: CWD, model: "gpt-5.3-codex" },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { cwd: CWD, model: "gpt-5.4-mini" },
        }),
      ].join("\n"),
    );

    expect(await readCodexModelFromRollout(path)).toBe("gpt-5.4-mini");

    fs.rmSync(home, { recursive: true, force: true });
  });
});
