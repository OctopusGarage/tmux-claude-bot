import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach } from "vitest";
import { envSchema } from "../src/shared/config.js";

// Hermetic config env. Production code reads the bot's configuration straight
// from process.env, so a developer whose shell exports the real prod/dev profile
// (LARK_APP_SECRET, *_UI_LANG, the allowlists, MLX_WHISPER_BIN, …) silently
// changes behavior under test: e.g. a present LARK_APP_SECRET turns ON
// card-action signature verification, which then drops every UNSIGNED value the
// card tests send. CI has none of these set, so the suite is green there and red
// locally — a non-hermetic-test bug, not a product bug. Strip the whole config
// surface here so every run matches CI; a test that needs a value sets it itself.
// Preserve only the dirs the harness owns (TCB_STATE_DIR is pinned below; log
// tests pin their own TCB_LOG_DIR).
const PRESERVE = new Set(["TCB_STATE_DIR", "TCB_LOG_DIR", "TCB_ENV_FILE"]);
const CLEAR = new Set<string>([
  ...Object.keys(envSchema.shape),
  // Read directly from process.env (not via envSchema):
  "CARD_SIGNING_SECRET",
  "TELEGRAM_UI_LANG",
  "LARK_UI_LANG",
  "WHISPER_LANGUAGE",
  "TELEGRAM_WHISPER_LANGUAGE",
  "LARK_WHISPER_LANGUAGE",
  "MLX_WHISPER_BIN",
]);
// The LARK_/TELEGRAM_ namespaces belong to this app's config — sweep any others.
for (const k of Object.keys(process.env)) {
  if (k.startsWith("LARK_") || k.startsWith("TELEGRAM_")) CLEAR.add(k);
}
for (const k of CLEAR) if (!PRESERVE.has(k)) delete process.env[k];

// Isolate the bot's mutable state files (recent_projects.txt,
// session_path_map.json, .current_project) in a per-run temp dir so the suite
// never writes into the real ~/.tmux-claude-bot. Without this, tests that
// exercise the real appendRecentProject / setPathForSession pollute the live
// state files, and a dev bot then shows that test garbage. See shared/state-dir.ts.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-test-state-"));
process.env.TCB_STATE_DIR = STATE_DIR;
// NOTE: logs are isolated via TCB_STATE_DIR (the logger resolves
// `appStateFile("logs")`). We deliberately do NOT pin TCB_LOG_DIR here: several
// log tests (logs.test.ts, logger.test.ts, agentKindMap-log.test.ts) set their
// OWN TCB_LOG_DIR at module load and a global one collides with that timing.

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
