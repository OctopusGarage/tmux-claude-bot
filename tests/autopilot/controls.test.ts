import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAutopilotVerb,
  autopilotDisable,
  autopilotEnable,
  autopilotStatusText,
  parseAutopilotVerb,
} from "../../src/core/autopilot/controls.js";
import { AutopilotStore } from "../../src/core/autopilot/state-store.js";
import { messages } from "../../src/core/i18n/index.js";

let dir: string;
let store: AutopilotStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-ctl-"));
  process.env.TCB_STATE_DIR = dir;
  store = new AutopilotStore();
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("controls", () => {
  it("enable starts a fresh run with keep-alive and resets counters", () => {
    autopilotEnable(store, "s1", { keepAlive: true });
    const st = store.get("s1");
    expect(st.enabled).toBe(true);
    expect(st.pureKeepAlive).toBe(true);
    expect(st.iterations).toBe(0);
    expect(st.startedAt).toBeTypeOf("number");
  });

  it("status text reflects on/off", () => {
    expect(autopilotStatusText(store, "s1", messages("telegram"))).toContain("关");
    autopilotEnable(store, "s1");
    expect(autopilotStatusText(store, "s1", messages("telegram"))).toContain("开");
    autopilotDisable(store, "s1");
    expect(autopilotStatusText(store, "s1", messages("telegram"))).toContain("关");
  });

  it("intervention count shows goalIterations in goal mode (not the keep-alive counter)", () => {
    // Goal mode injects via goalIterations; the keep-alive `iterations` stays 0,
    // so the status must read goalIterations or it's stuck at "intervened 0 times".
    store.set("s1", {
      ...store.get("s1"),
      enabled: true,
      goalId: "fix-tests",
      iterations: 0,
      goalIterations: 3,
    });
    expect(autopilotStatusText(store, "s1", messages("telegram"))).toContain("已干预 3 次");
  });
});

describe("autopilot verb: goals cycle", () => {
  it("parses `goals a,b rounds 3`", () => {
    expect(parseAutopilotVerb("goals fix-tests,code-review rounds 3")).toEqual({
      verb: "goals",
      ids: ["fix-tests", "code-review"],
      rounds: 3,
    });
  });

  it("`goal x` is sugar for a one-goal cycle, rounds 1", () => {
    expect(parseAutopilotVerb("goal fix-tests")).toEqual({
      verb: "goals",
      ids: ["fix-tests"],
      rounds: 1,
    });
  });

  it("clamps rounds to [1, MAX] and rejects unknown ids", () => {
    applyAutopilotVerb(store, "s1", "goals fix-tests rounds 999", messages("telegram"));
    expect(store.get("s1").rounds).toBe(10);
    const out = applyAutopilotVerb(store, "s2", "goals nope", messages("telegram"));
    expect(out).toMatch(/fix-tests/); // unknown-goal message lists valid ids
  });

  it("honours a configured maxRounds above the fallback", () => {
    // parser clamps to the passed cap, not the hardcoded fallback of 10
    expect(parseAutopilotVerb("goals fix-tests rounds 15", 20)).toMatchObject({ rounds: 15 });
    applyAutopilotVerb(store, "s1", "goals fix-tests rounds 15", messages("telegram"), 20);
    expect(store.get("s1").rounds).toBe(15);
  });

  it("starts the cycle state", () => {
    applyAutopilotVerb(store, "s1", "goals fix-tests,code-review rounds 2", messages("telegram"));
    const s = store.get("s1");
    expect(s.goalQueue).toEqual(["fix-tests", "code-review"]);
    expect(s.rounds).toBe(2);
    expect(s.enabled).toBe(true);
  });
});
