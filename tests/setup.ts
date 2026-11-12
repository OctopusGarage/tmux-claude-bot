import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach } from "vitest";
import { envSchema } from "../src/shared/config.js";

// Hermetic config env. Production code reads the bot's configuration straight
// from process.env, so a developer whose shell exports the real prod/dev profile
// (LARK_APP_SECRET, *_UI_LANG, the allowlists, MLX_WHISPER_BIN, …) silently
// changes behavior under test: e.g. a present LARK_APP_SECRET turns ON
// card-action signature verification, which then drops every UNSIGNED value the
// card tests send. CI has none of these set, so the suite is green there and red
// locally — a non-hermetic-test bug, not a product bug. Strip the whole config
// surface here so every run matches CI; a test that needs a value sets it itself.
// Never inherit production destinations. TCB_STATE_DIR is replaced with the
// per-worker temp directory below; tests that exercise explicit log/env-file
// overrides set their own values after this setup runs.
const PRESERVE = new Set<string>();
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
  "PROMPT_TRANSLATE_MODE",
  "PROMPT_TRANSLATE_FROM",
  "PROMPT_TRANSLATE_TO",
  "PROMPT_TRANSLATE_TIMEOUT_MS",
  "TELEGRAM_PROMPT_TRANSLATE_MODE",
  "TELEGRAM_PROMPT_TRANSLATE_FROM",
  "TELEGRAM_PROMPT_TRANSLATE_TO",
  "LARK_PROMPT_TRANSLATE_MODE",
  "LARK_PROMPT_TRANSLATE_FROM",
  "LARK_PROMPT_TRANSLATE_TO",
  "CONTROL_PROMPT_TRANSLATE_MODE",
  "CONTROL_PROMPT_TRANSLATE_FROM",
  "CONTROL_PROMPT_TRANSLATE_TO",
  "VOICE_TRANSLATE_MODE",
  "VOICE_TRANSLATE_FROM",
  "VOICE_TRANSLATE_TO",
  "VOICE_TRANSLATE_TIMEOUT_MS",
  "TELEGRAM_VOICE_TRANSLATE_MODE",
  "TELEGRAM_VOICE_TRANSLATE_FROM",
  "TELEGRAM_VOICE_TRANSLATE_TO",
  "LARK_VOICE_TRANSLATE_MODE",
  "LARK_VOICE_TRANSLATE_FROM",
  "LARK_VOICE_TRANSLATE_TO",
  "ARGOS_TRANSLATE_PYTHON",
  "TCB_STATE_DIR",
  "TCB_LOG_DIR",
  "TCB_ENV_FILE",
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
// Setup runs before each test file is imported. Route all of that file's ordinary
// temp fixtures into one owned sandbox, including fixtures created by helpers or
// child processes. Teardown runs after the file's hooks even when a test fails.
const originalTemp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
const TEMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "f-")));
process.env.TMPDIR = TEMP_ROOT;
process.env.TMP = TEMP_ROOT;
process.env.TEMP = TEMP_ROOT;
const removeTemporaryRoot = fs.rmSync;
afterAll(() => {
  for (const [key, value] of Object.entries(originalTemp)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTemporaryRoot(TEMP_ROOT, { recursive: true, force: true });
});
const STATE_DIR = fs.mkdtempSync(path.join(TEMP_ROOT, "tcb-test-state-"));
process.env.TCB_STATE_DIR = STATE_DIR;
// Logs are isolated through TCB_STATE_DIR because the logger resolves
// `appStateFile("logs")`. Individual logger tests may still set TCB_LOG_DIR.

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
