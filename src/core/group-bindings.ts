import { JsonMapStore } from "./json-map-store.js";

/** A group is permanently associated with one workspace. `workspacePath` is the
 * source of truth for re-anchoring; `sessionName`/`label` are derived snapshots. */
export interface GroupBinding {
  workspacePath: string;
  sessionName: string;
  label: string;
}

const store = new JsonMapStore<GroupBinding>("group_bindings.json");

export function bindGroup(chatId: string, binding: GroupBinding): void {
  store.set(chatId, binding);
}

export function getBinding(chatId: string): GroupBinding | null {
  return store.get(chatId) ?? null;
}

export function isProjectGroup(chatId: string): boolean {
  return store.has(chatId);
}

export function unbindGroup(chatId: string): boolean {
  return store.delete(chatId);
}

export function listBindings(): Array<{ chatId: string; binding: GroupBinding }> {
  return store.sortedEntries().map(([chatId, binding]) => ({ chatId, binding }));
}

/** The group already bound to `sessionName`, if any — enforces one workspace ↔
 *  one group, so a second group isn't created/bound for a project that has one. */
export function bindingForSession(
  sessionName: string,
): { chatId: string; binding: GroupBinding } | null {
  return listBindings().find(({ binding }) => binding.sessionName === sessionName) ?? null;
}
