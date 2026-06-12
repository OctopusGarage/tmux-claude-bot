import * as fs from "node:fs";
import { writeFileAtomicSync } from "../shared/utils/atomic-write.js";
import { appStateFile } from "./state-dir.js";

const bindingsFile = (): string => appStateFile("group_bindings.json");

/** A group is permanently associated with one workspace. `workspacePath` is the
 * source of truth for re-anchoring; `sessionName`/`label` are derived snapshots. */
export interface GroupBinding {
  workspacePath: string;
  sessionName: string;
  label: string;
}

type BindingMap = Record<string, GroupBinding>;

function readMap(): BindingMap {
  try {
    return JSON.parse(fs.readFileSync(bindingsFile(), "utf-8")) as BindingMap;
  } catch {
    return {};
  }
}

function writeMap(map: BindingMap): void {
  writeFileAtomicSync(bindingsFile(), `${JSON.stringify(map, null, 2)}\n`);
}

export function bindGroup(chatId: string, binding: GroupBinding): void {
  const map = readMap();
  map[chatId] = binding;
  writeMap(map);
}

export function getBinding(chatId: string): GroupBinding | null {
  return readMap()[chatId] ?? null;
}

export function isProjectGroup(chatId: string): boolean {
  return chatId in readMap();
}

export function unbindGroup(chatId: string): boolean {
  const map = readMap();
  if (!(chatId in map)) return false;
  delete map[chatId];
  writeMap(map);
  return true;
}

export function listBindings(): Array<{ chatId: string; binding: GroupBinding }> {
  return Object.entries(readMap())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([chatId, binding]) => ({ chatId, binding }));
}
