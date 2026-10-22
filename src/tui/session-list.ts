import type { SessionRow } from "../core/dashboard/dashboard.js";

function rowRank(row: SessionRow): number {
  if (row.busy) return 0;
  if (!row.running) return 1;
  return 2;
}

/** Stable health-first ordering with identity-based selection across refreshes. */
export function reconcileTuiSessionRows(
  incoming: SessionRow[],
  selectedSession: string | undefined,
): { rows: SessionRow[]; selectedIndex: number } {
  const rows = incoming
    .map((row, index) => ({ row, index }))
    .sort((left, right) => rowRank(left.row) - rowRank(right.row) || left.index - right.index)
    .map(({ row }) => row);
  const selectedIndex =
    selectedSession === undefined
      ? 0
      : Math.max(
          0,
          rows.findIndex((row) => row.session === selectedSession),
        );
  return { rows, selectedIndex };
}
