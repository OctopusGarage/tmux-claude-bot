import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { HandlerDeps } from "../deps.js";
import { freeLabel, freeSlotOf, getFreeProject } from "../projects/free-projects.js";
import { projectLabel } from "../projects/project-label.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import type { ScheduledTarget } from "./types.js";

const exec = promisify(execFile);
export async function captureScheduledTarget(
  deps: HandlerDeps,
  sessionName: string,
): Promise<ScheduledTarget> {
  if (!sessionName.startsWith(deps.config.projectSessionPrefix) || /[:.\n\r]/.test(sessionName))
    throw new Error("Select a managed session");
  const { stdout } = await exec(
    "tmux",
    [
      "display-message",
      "-p",
      "-t",
      `=${sessionName}:0.0`,
      "#{session_name}\t#{pid}\t#{session_id}\t#{session_created}\t#{pane_id}",
    ],
    { timeout: 5000 },
  );
  const [actual, pid, id, created, pane] = stdout.trim().split("\t");
  if (actual !== sessionName || !pid || !id || !created || !pane)
    throw new Error("Target session identity unavailable");
  const path = getPathBySession(sessionName);
  const workspacePath = path ? realpathSync(path) : null;
  const slot = freeSlotOf(sessionName, deps.config.projectSessionPrefix);
  return {
    sessionName,
    label:
      slot === null
        ? projectLabel(sessionName, workspacePath ?? undefined)
        : freeLabel(slot, getFreeProject(slot), workspacePath),
    workspacePath,
    incarnation: [pid, id, created, pane].join(":"),
  };
}
export function sameTarget(a: ScheduledTarget, b: ScheduledTarget): boolean {
  return (
    a.sessionName === b.sessionName &&
    a.workspacePath === b.workspacePath &&
    a.incarnation === b.incarnation
  );
}
