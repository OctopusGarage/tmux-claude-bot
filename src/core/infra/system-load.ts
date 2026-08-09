import { execFile } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { promisify } from "node:util";
import type { CpuTotals } from "./system-metrics.js";
import { hostCpuBusyPct, hostCpuTotals } from "./system-metrics.js";

const run = promisify(execFile);

export interface ProcLine {
  pid: number;
  cpu: number;
  time: string;
  command: string;
}

export interface SystemLoadReport {
  load: { one: number; five: number; fifteen: number };
  cores: number;
  /** 1-min load as a percentage of total CPU capacity (one / cores * 100). */
  loadPct: number;
  /** Human note: thermal pressure / throttling, or "n/a" off macOS. */
  thermal: string;
  top: ProcLine[];
  /** Orphaned shells (PPID 1, no tty) burning CPU — the "dead terminal left a
   * busy-looping shell" case; safe to kill. */
  orphans: ProcLine[];
  /** Aggregate host CPU busy percentage, when the caller supplies a baseline. */
  hostCpuPct?: number;
}

export interface SystemLoadProbes {
  loadAvg(): readonly [number, number, number];
  cpuCount(): number;
  /** Aggregate CPU time counters used only when an explicit baseline is supplied. */
  cpuTotals?(): CpuTotals;
  /** `pmset -g therm` (macOS); empty string when unavailable. */
  thermalRaw(): Promise<string>;
  /** `top` second-sample stdout (macOS); empty string when unavailable. */
  topRaw(limit: number): Promise<string>;
  /** `ps -axo pid,ppid,tty,%cpu,time,comm` stdout. */
  psRaw(): Promise<string>;
}

// ── Pure parsers (the fiddly bits — unit-tested) ─────────────────────────────

/** Parse `top -l 2 -stats pid,cpu,time,command` — keep only the SECOND sample
 * (the first is bogus), and only real process rows (skip the header/date lines). */
export function parseTop(stdout: string): ProcLine[] {
  const lines = stdout.split("\n");
  // Two "Processes:" headers; everything after the last one is the live sample.
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith("Processes:")) start = i;
  }
  const out: ProcLine[] = [];
  for (const line of lines.slice(start)) {
    // pid  cpu  time  command...  — pid must lead (excludes the "2026/.." date row).
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const [, pid, cpu, time, command] = m;
    if (pid && cpu && time && command) {
      out.push({ pid: Number(pid), cpu: Number(cpu), time, command });
    }
  }
  return out;
}

/** Orphaned, busy-looping shells: PPID 1 + no controlling tty + a shell name +
 * meaningful CPU. From `ps -axo pid,ppid,tty,%cpu,time,comm`. */
export function parseOrphanShells(stdout: string, minCpu = 10): ProcLine[] {
  const out: ProcLine[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const [, pid, ppid, tty, cpu, time, comm] = m;
    if (!pid || !ppid || !tty || !cpu || !time || !comm) continue;
    if (
      ppid === "1" &&
      tty === "??" &&
      Number(cpu) >= minCpu &&
      /(?:^-?)(zsh|bash|fish|sh)$/.test(comm)
    ) {
      out.push({ pid: Number(pid), cpu: Number(cpu), time, command: comm });
    }
  }
  return out;
}

/** Turn `pmset -g therm` into a one-line verdict. */
export function parseThermal(stdout: string): string {
  if (!stdout.trim()) return "n/a (macOS only)";
  // pmset prints "No thermal warning level has been recorded" when all is well.
  return /no thermal warning/i.test(stdout)
    ? "no pressure (not throttling)"
    : "THROTTLING / under thermal pressure";
}

// ── Assemble + render ────────────────────────────────────────────────────────

export async function gatherSystemLoad(
  probes: SystemLoadProbes,
  topLimit = 8,
  previousCpuTotals?: CpuTotals,
): Promise<SystemLoadReport> {
  const [one, five, fifteen] = probes.loadAvg();
  const cores = probes.cpuCount();
  const currentCpuTotals = previousCpuTotals && probes.cpuTotals ? probes.cpuTotals() : undefined;
  const [thermalRaw, topRaw, psRaw] = await Promise.all([
    probes.thermalRaw(),
    probes.topRaw(topLimit),
    probes.psRaw(),
  ]);
  return {
    load: { one, five, fifteen },
    cores,
    loadPct: cores > 0 ? Math.round((one / cores) * 100) : 0,
    thermal: parseThermal(thermalRaw),
    top: parseTop(topRaw).slice(0, topLimit),
    orphans: parseOrphanShells(psRaw),
    ...(currentCpuTotals && previousCpuTotals
      ? { hostCpuPct: hostCpuBusyPct(previousCpuTotals, currentCpuTotals) }
      : {}),
  };
}

const fix = (n: number): string => n.toFixed(2);

/** Plain text + emoji — reads cleanly in a terminal AND in a chat message. */
export function renderSystemLoad(r: SystemLoadReport): string {
  const lines: string[] = [];
  lines.push(
    `Load: ${fix(r.load.one)} / ${fix(r.load.five)} / ${fix(r.load.fifteen)}  (${r.cores} cores, 1-min ≈ ${r.loadPct}%)`,
  );
  lines.push(`Thermal: ${r.thermal}`);
  if (r.top.length) {
    lines.push("");
    lines.push("Top CPU:");
    for (const p of r.top) {
      lines.push(
        ` • ${p.command.slice(0, 22).padEnd(22)} ${String(Math.round(p.cpu)).padStart(3)}% · ${p.time}`,
      );
    }
  }
  lines.push("");
  if (r.orphans.length) {
    lines.push("⚠️ Runaway/orphan shells (dead terminal, safe to kill):");
    for (const o of r.orphans) {
      lines.push(
        ` • pid ${o.pid}  ${Math.round(o.cpu)}% · ${o.time}  ${o.command}  →  kill -9 ${o.pid}`,
      );
    }
  } else {
    lines.push("Runaway/orphan shells: none ✅");
  }
  return lines.join("\n");
}

export function defaultSystemLoadProbes(): SystemLoadProbes {
  const safe = async (cmd: string, args: string[]): Promise<string> => {
    try {
      const { stdout } = await run(cmd, args);
      return stdout;
    } catch {
      return "";
    }
  };
  return {
    loadAvg: () => loadavg() as [number, number, number],
    cpuCount: () => cpus().length,
    cpuTotals: hostCpuTotals,
    thermalRaw: () => safe("pmset", ["-g", "therm"]),
    topRaw: (limit) =>
      safe("top", ["-l", "2", "-o", "cpu", "-n", String(limit), "-stats", "pid,cpu,time,command"]),
    psRaw: () => safe("ps", ["-axo", "pid,ppid,tty,%cpu,time,comm"]),
  };
}
