import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach } from "vitest";

// Isolate the bot's mutable state files (recent_projects.txt,
// session_path_map.json, .current_project) in a per-run temp dir so the suite
// never writes into the real ~/.tmux-claude-bot. Without this, tests that
// exercise the real appendRecentProject / setPathForSession pollute the live
// state files, and a dev bot then shows that test garbage. See shared/state-dir.ts.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-test-state-"));
process.env.TCB_STATE_DIR = STATE_DIR;

// Safety net: several tests set their own TCB_STATE_DIR and then `delete` it in
// afterEach instead of restoring this value. That left a window (the next
// describe's tests) where TCB_STATE_DIR was unset and appStateDir() fell back to
// the REAL ~/.tmux-claude-bot — production code under test (e.g. the directory
// browser's create flow → appendRecentProject / setPathForSession) then wrote
// test temp paths into the live state files. Re-pin before every test if a prior
// test cleared it, so the real home is never used. Tests that set their own dir
// still win — their own beforeEach runs after this top-level one.
beforeEach(() => {
  if (!process.env.TCB_STATE_DIR) process.env.TCB_STATE_DIR = STATE_DIR;
});
