import { cpus } from "node:os";

export type CpuTotals = { idle: number; total: number };

type CpuTimeEntry = {
  times: {
    user: number;
    nice: number;
    sys: number;
    idle: number;
    irq: number;
  };
};

export function hostCpuBusyPct(previous: CpuTotals, current: CpuTotals): number {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0) return 0;

  const busyPct = Math.round(((total - idle) / total) * 100);
  return Number.isFinite(busyPct) ? Math.max(0, Math.min(100, busyPct)) : 0;
}

export function cpuTotalsFromEntries(entries: readonly CpuTimeEntry[]): CpuTotals {
  return entries.reduce<CpuTotals>(
    (totals, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      return { idle: totals.idle + cpu.times.idle, total: totals.total + total };
    },
    { idle: 0, total: 0 },
  );
}

export function hostCpuTotals(): CpuTotals {
  return cpuTotalsFromEntries(cpus());
}
