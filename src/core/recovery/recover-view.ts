import { displayPath } from "../projects/dir-browser.js";
import { projectLabel } from "../projects/project-label.js";
import type { RecoverAction, RecoverItem, RecoverResult } from "./recover.js";

/** The items recovery will actually act on (recreate/relaunch), for a preview. */
function actionable(items: RecoverItem[]): RecoverItem[] {
  return items.filter((i) => i.action === "launch" || i.action === "recreate-shell");
}

/** How many projects recovery would relaunch/recreate — drives the confirm prompt. */
export function actionableCount(items: RecoverItem[]): number {
  return actionable(items).length;
}

/** How many already-running projects recovery would skip (shown for context). */
export function aliveCount(items: RecoverItem[]): number {
  return items.filter((i) => i.action === "alive").length;
}

// Recoverable actions sort first so the numbered list runs "will recover" 1..N,
// then the skipped ones — matching the "will recover N" header count.
const ACTION_ORDER: Record<RecoverAction, number> = {
  launch: 0,
  "recreate-shell": 1,
  alive: 2,
  "missing-dir": 3,
};

/**
 * Numbered roster of EVERY rostered project, rendered like the dashboard (name +
 * an indented detail line), with a status icon so the ones that won't be touched
 * are marked too:
 *   🔁 relaunch the agent + resume   🐚 recreate the terminal only (no agent)
 *   🟢 already running — skipped       ⚠️ working dir gone — can't recover
 * Lines are language-neutral data; the surrounding prompt is translated by the caller.
 */
export function recoverPreviewList(items: RecoverItem[]): string {
  return [...items]
    .sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action])
    .map((i, idx) => {
      const n = `${idx + 1}`.padStart(2);
      const label = projectLabel(i.session, i.path);
      const path = displayPath(i.path);
      if (i.action === "launch") return `${n}. 🔁 ${label} · 🤖 ${i.kind}\n   ↳ ${path}`;
      if (i.action === "recreate-shell") return `${n}. 🐚 ${label}\n   ↳ ${path}`;
      if (i.action === "alive") return `${n}. 🟢 ${label}`;
      return `${n}. ⚠️ ${label}\n   ↳ ${path}`; // missing-dir — can't recover
    })
    .join("\n");
}

/** One roster line for the CLI/plain view: session, kind, resume mode, path. */
function itemLine(i: RecoverItem): string {
  const resume =
    i.command === null ? "shell" : i.sessionId ? `resume ${i.sessionId.slice(0, 8)}` : "continue";
  // displayPath → ~ for home: this feeds `tcb recover` stdout, a non-chat surface
  // that bypasses the send-boundary tildeify chokepoint (CLAUDE.md user-facing paths).
  return `  ${i.session}  [${i.kind}/${resume}]  ${displayPath(i.path)}`;
}

/**
 * Plain-text summary of a recovery run (or a `--dry-run` plan) for the CLI. The
 * chat surfaces build their own localized text from the same counts/lists.
 */
export function formatRecoverResult(res: RecoverResult, opts: { dryRun?: boolean } = {}): string {
  if (res.busy) return "A recovery is already in progress.";
  const total =
    res.launched.length +
    res.shellOnly.length +
    res.alreadyAlive.length +
    res.skippedMissingDir.length +
    res.failed.length;
  if (total === 0) return "No projects to recover.";

  const verb = opts.dryRun ? "Would relaunch" : "Relaunched";
  const lines: string[] = [`${verb}: ${res.launched.length}`];
  for (const i of res.launched) lines.push(itemLine(i));
  if (res.shellOnly.length) {
    lines.push(`Recreated (shell only): ${res.shellOnly.length}`);
    for (const i of res.shellOnly) lines.push(itemLine(i));
  }
  if (res.alreadyAlive.length) lines.push(`Already running: ${res.alreadyAlive.length}`);
  if (res.skippedMissingDir.length) {
    lines.push(`Skipped — working dir gone: ${res.skippedMissingDir.length}`);
    for (const i of res.skippedMissingDir) lines.push(itemLine(i));
  }
  if (res.failed.length) {
    lines.push(`Failed: ${res.failed.length}`);
    for (const f of res.failed) lines.push(`  ${f.item.session}: ${f.error}`);
  }
  return lines.join("\n");
}
