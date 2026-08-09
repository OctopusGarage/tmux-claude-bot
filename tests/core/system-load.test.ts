import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  gatherSystemLoad,
  parseOrphanShells,
  parseThermal,
  parseTop,
  renderSystemLoad,
  type SystemLoadProbes,
} from "../../src/core/infra/system-load.js";

const TOP = `Processes: 1 total
2026/06/20 11:35:01
Load Avg: 5.34, 5.66, 5.67
ignored first sample
Processes: 520 total, 7 running
2026/06/20 11:36:34
PID    %CPU TIME     COMMAND
525    69.5 12:03:58 mds_stores
11260  98.2 23:16:32 -zsh
691    22.7 89:22.90 iTerm2`;

const PS = `  PID  PPID TTY        %CPU      TIME COMM
11260     1 ??         98.2  23:16:32 -zsh
99999     1 ??          0.1  00:00:01 -zsh
40000   501 ttys001     3.0  00:10:00 -zsh
525       1 ??         69.5  12:03:58 mds_stores`;

describe("parseTop", () => {
  it("keeps only the second sample's process rows (skips date/header lines)", () => {
    const rows = parseTop(TOP);
    expect(rows.map((r) => r.command)).toEqual(["mds_stores", "-zsh", "iTerm2"]);
    expect(rows[0]).toMatchObject({ pid: 525, cpu: 69.5, time: "12:03:58" });
    // the "2026/.." date row and "PID %CPU" header must not appear as processes
    expect(rows.some((r) => r.command.includes("2026"))).toBe(false);
  });
});

describe("parseOrphanShells", () => {
  it("flags only PPID=1 + no-tty + shell + high-CPU (the 23h-zombie pattern)", () => {
    const orphans = parseOrphanShells(PS);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ pid: 11260, cpu: 98.2, command: "-zsh" });
    // 99999 is a low-CPU orphan shell; 40000 has a tty; 525 isn't a shell → all excluded
  });

  it("returns nothing when there are no runaway orphan shells", () => {
    expect(
      parseOrphanShells("  PID  PPID TTY %CPU TIME COMM\n40000 501 ttys001 3.0 00:10 -zsh"),
    ).toEqual([]);
  });
});

describe("parseThermal", () => {
  it("reads pmset verdicts", () => {
    expect(parseThermal("No thermal warning level has been recorded")).toMatch(/no pressure/);
    expect(parseThermal("CPU_Speed_Limit = 80")).toMatch(/THROTTLING/);
    expect(parseThermal("")).toMatch(/n\/a/);
  });
});

describe("gatherSystemLoad + renderSystemLoad", () => {
  const probes: SystemLoadProbes = {
    loadAvg: () => [4.0, 5.0, 6.0],
    cpuCount: () => 8,
    thermalRaw: async () => "No thermal warning level has been recorded",
    topRaw: async () => TOP,
    psRaw: async () => PS,
  };

  it("computes loadPct and assembles the report", async () => {
    const r = await gatherSystemLoad(probes);
    expect(r.loadPct).toBe(50); // 4 / 8 * 100
    expect(r.cores).toBe(8);
    expect(r.orphans).toHaveLength(1);
    expect(r.top.length).toBeGreaterThan(0);
  });

  it("adds host CPU busy percentage only when given a CPU baseline", async () => {
    const r = await gatherSystemLoad(
      { ...probes, cpuTotals: () => ({ idle: 120, total: 500 }) },
      8,
      { idle: 100, total: 400 },
    );

    expect(r.hostCpuPct).toBe(80);
    expect(await gatherSystemLoad(probes)).not.toHaveProperty("hostCpuPct");
  });

  it("renders orphans with a kill hint, and the load/thermal lines", async () => {
    const out = renderSystemLoad(await gatherSystemLoad(probes));
    expect(out).toContain("Load: 4.00 / 5.00 / 6.00  (8 cores, 1-min ≈ 50%)");
    expect(out).toContain("not throttling");
    expect(out).toContain("kill -9 11260");
  });

  it("renders a clean line when there are no orphans", async () => {
    const out = renderSystemLoad(
      await gatherSystemLoad({ ...probes, psRaw: async () => "PID PPID TTY %CPU TIME COMM" }),
    );
    expect(out).toContain("Runaway/orphan shells: none");
    expect(out).not.toContain("kill -9");
  });

  it("renders optional Resource Guardian context without exposing an absent incident", async () => {
    const out = renderSystemLoad(await gatherSystemLoad(probes), {
      enabled: true,
      mode: "protect",
      profile: "balanced",
      pressure: "critical",
      circuit: "background-closed",
      incidentId: null,
      reason: `${homedir()}/work token=super-secret`,
      attribution: "bot-owned",
      latestSample: null,
      stableSince: null,
      sampling: {
        degraded: false,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastError: null,
        notifiedPhase: null,
        overlapSkippedTicks: 0,
      },
    });
    expect(out).toContain("Resource Guardian: critical · background closed");
    expect(out).toContain("Reason: ~/work token=<redacted>");
    expect(out).not.toContain(homedir());
    expect(out).not.toContain("super-secret");
    expect(out).toContain("Attribution: bot-owned");
    expect(out).not.toContain("Incident: null");
  });
});
