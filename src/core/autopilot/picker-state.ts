/** Transient per-session goal-picker selection (which goals are ticked + the
 * round count) before the user taps "开始". In-memory and rebuildable — NOT
 * persisted: a restart just drops an in-progress selection (no message lost).
 * Shared by every surface (Telegram/Lark/TUI). */
export type PickerState = { selected: string[]; rounds: number };

const pickers = new Map<string, PickerState>();

export function getPicker(session: string): PickerState {
  return pickers.get(session) ?? { selected: [], rounds: 1 };
}

export function toggleGoal(session: string, goalId: string): void {
  const p = { ...getPicker(session), selected: [...getPicker(session).selected] };
  const i = p.selected.indexOf(goalId);
  if (i >= 0) p.selected.splice(i, 1);
  else p.selected.push(goalId);
  pickers.set(session, p);
}

export function adjustRounds(session: string, delta: number, max: number): void {
  const p = getPicker(session);
  pickers.set(session, { ...p, rounds: Math.min(max, Math.max(1, p.rounds + delta)) });
}

export function clearPicker(session: string): void {
  pickers.delete(session);
}
