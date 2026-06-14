import { describe, expect, it } from "vitest";
import {
  categorizeStatusLine,
  manualSnippet,
  statuslineScript,
} from "../src/core/status-install.js";

const OURS = "/state/status-snapshots/statusline.sh";

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
});
