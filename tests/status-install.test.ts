import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  categorizeStatusLine,
  manualSnippet,
  statuslineScript,
} from "../src/core/status-install.js";

const OURS = "/state/status-snapshots/statusline.sh";

let hasShellTools = false;
try {
  execFileSync("bash", ["-c", "command -v jq >/dev/null && command -v date >/dev/null"]);
  hasShellTools = true;
} catch {
  /* jq/date absent — skip the run-the-script test */
}

describe("categorizeStatusLine", () => {
  it("is clean when no statusLine is set", () => {
    expect(categorizeStatusLine({}, OURS).state).toBe("clean");
    expect(categorizeStatusLine({ statusLine: {} }, OURS).state).toBe("clean");
    expect(categorizeStatusLine(null, OURS).state).toBe("clean");
  });

  it("is ours when the command is our script (standalone or wrap form)", () => {
    expect(categorizeStatusLine({ statusLine: { command: OURS } }, OURS).state).toBe("ours");
    expect(
      categorizeStatusLine({ statusLine: { command: `${OURS} /state/orig.cmd` } }, OURS).state,
    ).toBe("ours");
  });

  it("is foreign for someone else's command, and surfaces it", () => {
    const res = categorizeStatusLine({ statusLine: { command: "~/my-statusline.sh" } }, OURS);
    expect(res.state).toBe("foreign");
    expect(res.foreignCmd).toBe("~/my-statusline.sh");
  });
});

describe("statuslineScript / manualSnippet", () => {
  it("bakes the snapshot dir and writes keyed by session_id", () => {
    const s = statuslineScript("/state/status-snapshots");
    expect(s).toContain("/state/status-snapshots");
    expect(s).toContain(".session_id");
    expect(s).toContain("rate_limits.five_hour.used_percentage");
    expect(s.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("manual snippet carries the jq write without the status-line echo", () => {
    const snip = manualSnippet("/state/status-snapshots");
    expect(snip).toContain("jq -c");
    expect(snip).not.toContain("#!/usr/bin/env bash");
  });

  it.skipIf(!hasShellTools)(
    "renders a rich two-line statusline (ctx bar + session/weekly + reset) from real input",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "tcb-sl-"));
      const f = join(dir, "statusline.sh");
      writeFileSync(f, statuslineScript(dir), { mode: 0o755 });
      const input = JSON.stringify({
        model: { display_name: "Opus 4.8" },
        context_window: { used_percentage: 88 },
        rate_limits: {
          five_hour: { used_percentage: 98, resets_at: 1781503200 },
          seven_day: { used_percentage: 10, resets_at: 1782075600 },
        },
      });
      const out = execFileSync("bash", ["-c", `printf %s '${input}' | '${f}'`]).toString();
      expect(out).toContain("88% ctx");
      expect(out).toContain("session 98%");
      expect(out).toContain("weekly 10%");
      expect(out).toContain("(reset ");
      expect(out).toContain("█"); // progress bar rendered
    },
  );
});
