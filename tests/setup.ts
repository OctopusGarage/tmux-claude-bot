import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Isolate the bot's mutable state files (recent_projects.txt,
// session_path_map.json, .current_project) in a per-run temp dir so the suite
// never writes into the checkout. Without this, tests that exercise the real
// appendRecentProject / setPathForSession pollute the repo's state files, and a
// dev bot run from the checkout then shows that test garbage. See shared/state-dir.ts.
process.env.TCB_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-test-state-"));
