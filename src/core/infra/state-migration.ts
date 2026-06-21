import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";

const log = createLogger("infra.state-migration");

/**
 * State artifacts that used to live directly in the app-home root
 * (`~/.tmux-claude-bot`) before the `state/` subdir split. Source of truth for
 * BOTH the boot-time relocation here AND the `install.sh` deploy excludes — a
 * guard test (`state-dir.test.ts`) asserts every name is excluded from the
 * deploy's `rsync --delete`, so the transition deploy can't wipe a file before
 * this migration moves it. `logs` is intentionally absent: it stays at the home
 * root (the wrappers pin `TCB_LOG_DIR=<home>/logs`) and is excluded separately.
 */
export const LEGACY_STATE_NAMES = [
  ".env",
  ".current_project",
  ".queue",
  "recent_projects.txt",
  "media",
  "status-snapshots",
  "group_bindings.json",
  "workspaces.json",
  "auth.json",
  "settings.json",
  "free_projects.json",
  "session_path_map.json",
  "session_agent_map.json",
  "session_live_id_map.json",
  "session_task_time.json",
  "lark_reply_target_map.json",
  "reply_target_map.json",
] as const;

/**
 * One-time relocation of state from the app-home root into the `state/` subdir.
 *
 * State used to live directly in `~/.tmux-claude-bot`, which is ALSO the code
 * install dir. The deploy mirrors releases there with `rsync --delete`, silently
 * wiping any state file not in its exclude list — this is what erased
 * `group_bindings.json` on every deploy, bricking Feishu project groups. State
 * now lives in `<home>/state` (one excluded dir); this moves any legacy
 * root-level state into it on boot.
 *
 * Idempotent and best-effort: it never throws into the caller, only moves a
 * legacy file when the new location is absent (a post-migration file is never
 * clobbered), and runs only when the resolved state dir is the `state/` subdir
 * (so a custom `TCB_STATE_DIR` — tests, bespoke setups — is left untouched).
 */
export function migrateLegacyStateDir(): void {
  try {
    const stateDir = appStateDir();
    // Only the conventional `<home>/state` layout migrates. A custom TCB_STATE_DIR
    // not named `state` is the operator's explicit choice — leave it alone (this
    // also keeps the per-test temp dirs out of the migration path).
    if (basename(stateDir) !== "state") return;
    const home = dirname(stateDir);
    fs.mkdirSync(stateDir, { recursive: true });
    for (const name of LEGACY_STATE_NAMES) {
      const from = join(home, name);
      const to = join(stateDir, name);
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.renameSync(from, to);
          log.info("relocated legacy state into state/ subdir", { data: { name } });
        }
      } catch (err) {
        log.warn(`state migration: could not move ${name}: ${String(err)}`);
      }
    }
  } catch (err) {
    log.warn(`state migration skipped: ${String(err)}`);
  }
}
