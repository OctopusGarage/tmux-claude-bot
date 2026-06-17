import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexUsageFromRollout,
  readCodexUsage,
  resolveCodexApiInfo,
} from "../src/core/agents/codex/codex-usage.js";

const fixture = fs.readFileSync(join(__dirname, "fixtures/codex-rollout.jsonl"), "utf8");

describe("codexUsageFromRollout", () => {
  it("maps the LAST token_count event to a UsageSnapshot", () => {
    const snap = codexUsageFromRollout(fixture, "sess_x", 1774644000);
    expect(snap).not.toBeNull();
    expect(snap?.contextPct).toBe(75); // 750/1000
    expect(snap?.fiveHourPct).toBe(42);
    expect(snap?.fiveHourReset).toBe(1774644296);
    expect(snap?.sevenDayPct).toBe(7);
    expect(snap?.sevenDayReset).toBe(1775000000);
    expect(snap?.sessionId).toBe("sess_x");
    expect(snap?.updatedAt).toBe(1774644000);
  });
  it("returns null when there is no token_count event", () => {
    const onlyMeta = `{"type":"session_meta","payload":{"id":"x","cwd":"/tmp"}}`;
    expect(codexUsageFromRollout(onlyMeta, "sess_x", 0)).toBeNull();
  });
  it("returns null for empty / garbage input", () => {
    expect(codexUsageFromRollout("", "s", 0)).toBeNull();
    expect(codexUsageFromRollout("not json\n{bad", "s", 0)).toBeNull();
  });
  it("clamps contextPct to 100 when total exceeds the window (post-compaction)", () => {
    const line = `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":1470},"model_context_window":1000}}}`;
    const snap = codexUsageFromRollout(line, "s", 0);
    expect(snap?.contextPct).toBe(100); // 147% raw → clamped
  });

  it("tolerates a missing context window (null contextPct)", () => {
    const line = `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":10}},"rate_limits":{"primary":{"used_percent":5,"resets_at":1},"secondary":{"used_percent":2,"resets_at":2}}}}`;
    const snap = codexUsageFromRollout(line, "s", 0);
    expect(snap?.contextPct).toBeNull();
    expect(snap?.fiveHourPct).toBe(5);
  });
});

describe("readCodexUsage (file finder)", () => {
  it("finds the rollout matching the project cwd", async () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "codex-home-"));
    const dir = join(root, "sessions", "2026", "03", "27");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "rollout-a.jsonl"), fixture);
    const snap = await readCodexUsage(
      { sessionId: "s", configRoot: root, projectPath: "/home/user/projects/demo" },
      1774644000,
    );
    expect(snap?.fiveHourPct).toBe(42);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("returns null when no rollout matches the cwd", async () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "codex-home-"));
    fs.mkdirSync(join(root, "sessions"), { recursive: true });
    expect(
      await readCodexUsage({ sessionId: "s", configRoot: root, projectPath: "/nope" }, 0),
    ).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prefers an explicit rolloutPath over the cwd scan (same-cwd contention)", async () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), "codex-home-"));
    const dir = join(root, "sessions", "2026", "03", "27");
    fs.mkdirSync(dir, { recursive: true });
    // Two rollouts share the cwd; the scan would pick the newer one, but the live
    // pid's open rollout (the explicit path) must win regardless of mtime.
    const live = join(dir, "rollout-live.jsonl");
    fs.writeFileSync(live, fixture);
    const newer = join(dir, "rollout-newer.jsonl");
    fs.writeFileSync(newer, fixture.replace('"used_percent":42', '"used_percent":99'));
    fs.utimesSync(newer, 9_000_000, 9_000_000);

    const snap = await readCodexUsage(
      {
        sessionId: "s",
        configRoot: root,
        projectPath: "/home/user/projects/demo",
        rolloutPath: live,
      },
      1774644000,
    );
    expect(snap?.fiveHourPct).toBe(42); // from the live file, not the newer one (99)
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("resolveCodexApiInfo", () => {
  function home(): string {
    return fs.mkdtempSync(join(os.tmpdir(), "codex-home-"));
  }

  it("returns null when auth.json is missing/unreadable", async () => {
    const root = home();
    expect(await resolveCodexApiInfo(root)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports api mode for auth_mode=apikey", async () => {
    const root = home();
    fs.writeFileSync(join(root, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
    expect(await resolveCodexApiInfo(root)).toEqual({ baseUrl: null, mode: "api" });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports api mode for a non-null OPENAI_API_KEY", async () => {
    const root = home();
    fs.writeFileSync(join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-xyz" }));
    expect(await resolveCodexApiInfo(root)).toEqual({ baseUrl: null, mode: "api" });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports subscription mode for a ChatGPT login (tokens present)", async () => {
    const root = home();
    fs.writeFileSync(
      join(root, "auth.json"),
      JSON.stringify({ tokens: { access_token: "t" }, OPENAI_API_KEY: null }),
    );
    expect(await resolveCodexApiInfo(root)).toEqual({ baseUrl: null, mode: "subscription" });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("extracts a custom provider base_url from config.toml", async () => {
    const root = home();
    fs.writeFileSync(join(root, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
    fs.writeFileSync(
      join(root, "config.toml"),
      '[model_providers.custom]\nbase_url = "https://proxy.example.com/v1"\n',
    );
    expect(await resolveCodexApiInfo(root)).toEqual({
      baseUrl: "https://proxy.example.com/v1",
      mode: "api",
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
