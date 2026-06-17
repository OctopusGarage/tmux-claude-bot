import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/core/projects/sessionPathMap.js", () => ({
  getPathBySession: () => "/proj/x",
}));
vi.mock("../../../../src/core/agents/claude/claude-history.js", () => ({
  listClaudeSessions: async () => [{ sessionId: "sid-1" }],
}));

import {
  buildStatusReport,
  parseUsageSnapshot,
  snapshotDir,
} from "../../../../src/core/agents/claude/claude-status.js";
import { formatUsageLines, type UsageSnapshot } from "../../../../src/core/read/usage.js";

describe("parseUsageSnapshot", () => {
  it("maps snake_case JSON to the snapshot shape", () => {
    const snap = parseUsageSnapshot(
      JSON.stringify({
        session_id: "s1",
        context_pct: 13,
        five_hour_pct: 47,
        five_hour_reset: 1000,
        seven_day_pct: 26,
        seven_day_reset: 2000,
        updated_at: 500,
      }),
    );
    expect(snap).toEqual({
      sessionId: "s1",
      contextPct: 13,
      fiveHourPct: 47,
      fiveHourReset: 1000,
      sevenDayPct: 26,
      sevenDayReset: 2000,
      updatedAt: 500,
    });
  });

  it("treats absent/invalid figures as null", () => {
    const snap = parseUsageSnapshot(JSON.stringify({ session_id: "s2", context_pct: "x" }));
    expect(snap?.contextPct).toBeNull();
    expect(snap?.fiveHourPct).toBeNull();
    expect(snap?.updatedAt).toBe(0);
  });

  it("returns null without a session_id or on bad JSON", () => {
    expect(parseUsageSnapshot(JSON.stringify({ context_pct: 1 }))).toBeNull();
    expect(parseUsageSnapshot("not json")).toBeNull();
  });
});

describe("formatUsageLines", () => {
  const base: UsageSnapshot = {
    sessionId: "s1",
    contextPct: 13,
    fiveHourPct: 47,
    fiveHourReset: 1_700_000_000,
    sevenDayPct: 92,
    sevenDayReset: 1_700_100_000,
    updatedAt: 2_000,
  };
  const now = 2_000 * 1000; // same as updatedAt → fresh

  it("renders one line per present figure with percent + bar", () => {
    const lines = formatUsageLines(base, "telegram", now);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("13%");
    expect(lines[1]).toContain("47%");
    expect(lines[2]).toContain("92%");
    expect(lines[2]).toContain("🔴"); // >=90 used → red
    expect(lines.join("")).toContain("█"); // bars rendered
  });

  it("omits windows that are absent (e.g. non-subscriber rate limits)", () => {
    const lines = formatUsageLines(
      { ...base, fiveHourPct: null, sevenDayPct: null },
      "telegram",
      now,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("13%");
  });

  it("appends a staleness note when the data is old", () => {
    const stale = formatUsageLines(base, "telegram", now + 20 * 60 * 1000);
    expect(stale).toHaveLength(4);
    expect(stale[3]).toContain("20");
  });

  it("returns nothing when the snapshot carries no figures", () => {
    expect(
      formatUsageLines(
        { ...base, contextPct: null, fiveHourPct: null, sevenDayPct: null },
        "telegram",
        now,
      ),
    ).toHaveLength(0);
  });
});

describe("buildStatusReport — installed-but-no-data vs not-installed", () => {
  const deps = { configResolver: { resolveConfigRoot: async () => "/cfg" } } as never;
  let orig: string | undefined;
  beforeEach(() => {
    orig = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = fs.mkdtempSync(join(tmpdir(), "tcb-us-"));
    fs.mkdirSync(snapshotDir(), { recursive: true });
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = orig;
  });

  it("shows the 'data pending' line (not the install nudge) when a snapshot exists with no figures", async () => {
    fs.writeFileSync(
      join(snapshotDir(), "sid-1.json"),
      JSON.stringify({
        session_id: "sid-1",
        context_pct: null,
        five_hour_pct: null,
        updated_at: 1,
      }),
    );
    const out = await buildStatusReport(deps, "sess", "telegram", true);
    expect(out).not.toContain("/status_install"); // already installed → no re-nudge
    expect(out).toContain("📊");
  });

  it("shows the API mode + base url host when the resolver reports api mode", async () => {
    const apiDeps = {
      configResolver: {
        resolveConfigRoot: async () => "/cfg",
        resolveApiInfo: async () => ({
          baseUrl: "https://api.minimaxi.com/anthropic",
          mode: "api",
        }),
      },
    } as never;
    const out = await buildStatusReport(apiDeps, "sess", "telegram", true);
    expect(out).toContain("🔌");
    expect(out).toContain("API");
    expect(out).toContain("api.minimaxi.com");
  });

  it("falls back to api.anthropic.com host for subscription mode (null base url)", async () => {
    const subDeps = {
      configResolver: {
        resolveConfigRoot: async () => "/cfg",
        resolveApiInfo: async () => ({ baseUrl: null, mode: "subscription" }),
      },
    } as never;
    const out = await buildStatusReport(subDeps, "sess", "telegram", true);
    expect(out).toContain("api.anthropic.com");
  });

  it("shows the install hint when no snapshot exists AND the integration is absent", async () => {
    // deps.resolveConfigRoot → "/cfg" (no settings.json) → not installed → nudge.
    const out = await buildStatusReport(deps, "sess", "telegram", true);
    expect(out).toContain("/status_install");
  });

  it("shows 'no data yet' (NOT the install nudge) when the integration IS installed but the session has no snapshot", async () => {
    // A config dir whose statusLine is our snapshot script → installed, even with
    // no snapshot for the resolved session. Must not wrongly tell the user to install.
    const cfg = fs.mkdtempSync(join(tmpdir(), "tcb-cfg-"));
    fs.writeFileSync(
      join(cfg, "settings.json"),
      JSON.stringify({ statusLine: { command: join(snapshotDir(), "statusline.sh") } }),
    );
    const installedDeps = { configResolver: { resolveConfigRoot: async () => cfg } } as never;
    const out = await buildStatusReport(installedDeps, "sess", "telegram", true);
    expect(out).not.toContain("/status_install");
    expect(out).toContain("📊");
  });

  it("detects the snippet/wrap install (our block pasted into a custom statusline script)", async () => {
    const cfg = fs.mkdtempSync(join(tmpdir(), "tcb-cfg-"));
    const userScript = join(cfg, "statusline.sh");
    // The user's own script with our snapshot block (marked by the snapshot dir path) pasted in.
    fs.writeFileSync(
      userScript,
      `#!/bin/bash\ninput=$(cat)\nmkdir -p '${snapshotDir()}'\necho hi\n`,
    );
    fs.writeFileSync(
      join(cfg, "settings.json"),
      JSON.stringify({ statusLine: { command: `bash ${userScript}` } }),
    );
    const wrapDeps = { configResolver: { resolveConfigRoot: async () => cfg } } as never;
    const out = await buildStatusReport(wrapDeps, "sess", "telegram", true);
    expect(out).not.toContain("/status_install"); // snippet install detected
  });

  it("does NOT treat a custom statusLine that merely mentions the snapshot path as installed", async () => {
    // A bespoke statusLine command whose ARGUMENT just contains the snapshot-dir
    // path as a substring (e.g. an echo) is not our integration — it must still
    // nudge to install, not be a false positive.
    const cfg = fs.mkdtempSync(join(tmpdir(), "tcb-cfg-"));
    fs.writeFileSync(
      join(cfg, "settings.json"),
      JSON.stringify({
        statusLine: { command: `echo "see ${snapshotDir()}-for-details"` },
      }),
    );
    const deps = { configResolver: { resolveConfigRoot: async () => cfg } } as never;
    const out = await buildStatusReport(deps, "sess", "telegram", true);
    expect(out).toContain("/status_install"); // not installed → still nudges
  });
});
