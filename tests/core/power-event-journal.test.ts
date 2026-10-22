import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendPowerEvent, readPowerEvents } from "../../src/core/power/power-event-journal.js";

describe("power event journal", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("returns only valid in-window events in chronological order", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-power-events-"));
    dirs.push(stateDir);
    const eventDir = join(stateDir, "power-events");
    mkdirSync(eventDir);
    writeFileSync(
      join(eventDir, "power-20260811.jsonl"),
      [
        JSON.stringify({
          at: Date.parse("2026-08-11T18:00:12.000Z"),
          kind: "keep-awake-released",
        }),
        "{torn",
        JSON.stringify({
          at: Date.parse("2026-08-11T18:00:00.000Z"),
          kind: "phase-transition",
          from: "service",
          to: "natural-sleep",
        }),
        JSON.stringify({ at: "not-a-number", kind: "keep-awake-acquired" }),
      ].join("\n"),
    );
    writeFileSync(
      join(eventDir, "power-20260812.jsonl"),
      `${JSON.stringify({
        at: Date.parse("2026-08-12T01:15:00.000Z"),
        kind: "keep-awake-acquired",
      })}\n`,
    );

    const result = readPowerEvents({
      stateDir,
      since: Date.parse("2026-08-11T18:00:05.000Z"),
      until: Date.parse("2026-08-12T01:20:00.000Z"),
    });

    expect(result.events).toEqual([
      { at: Date.parse("2026-08-11T18:00:12.000Z"), kind: "keep-awake-released" },
      { at: Date.parse("2026-08-12T01:15:00.000Z"), kind: "keep-awake-acquired" },
    ]);
    expect(result.invalidRecords).toBe(2);
  });

  it("appends typed events to the canonical daily journal", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-power-events-"));
    dirs.push(stateDir);
    appendPowerEvent(
      {
        at: Date.parse("2026-08-12T01:15:00.000Z"),
        kind: "phase-transition",
        from: "natural-sleep",
        to: "wake-warmup",
      },
      { stateDir },
    );

    expect(
      readPowerEvents({
        stateDir,
        since: Date.parse("2026-08-12T01:00:00.000Z"),
        until: Date.parse("2026-08-12T02:00:00.000Z"),
      }).events,
    ).toEqual([
      {
        at: Date.parse("2026-08-12T01:15:00.000Z"),
        kind: "phase-transition",
        from: "natural-sleep",
        to: "wake-warmup",
      },
    ]);
  });
});
