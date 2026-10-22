import { describe, expect, it } from "vitest";
import {
  advancePressureState,
  initialPressureMemory,
  PRESSURE_PROFILES,
} from "../../src/core/resource-guardian/pressure-policy.js";
import type { ResourceSample } from "../../src/core/resource-guardian/types.js";

const sample = (
  capturedAt: number,
  hostCpuPct: number,
  thermal: ResourceSample["thermal"] = "normal",
): ResourceSample => ({
  capturedAt,
  hostCpuPct,
  loadPct: hostCpuPct,
  eventLoopLagMs: 0,
  thermal,
});

const sampleWithLoad = (
  capturedAt: number,
  hostCpuPct: number,
  loadPct: number,
): ResourceSample => ({
  capturedAt,
  hostCpuPct,
  loadPct,
  eventLoopLagMs: 0,
  thermal: "normal",
});

const sampleWithEventLoopLag = (capturedAt: number, eventLoopLagMs: number): ResourceSample => ({
  capturedAt,
  hostCpuPct: 20,
  loadPct: 20,
  eventLoopLagMs,
  thermal: "normal",
});

describe("pressure policy", () => {
  it("keeps a CPU burst shorter than the elevated sustain window healthy", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 85), "balanced");
    memory = advancePressureState(memory, sample(59_999, 85), "balanced");

    expect(memory.pressure).toBe("healthy");
    expect(memory.elevatedSince).toBe(0);
  });

  it("moves sustained balanced critical pressure through recovery to healthy", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 94), "balanced");
    memory = advancePressureState(memory, sample(89_999, 94), "balanced");
    expect(memory.pressure).toBe("elevated");

    memory = advancePressureState(memory, sample(90_000, 94), "balanced");
    expect(memory.pressure).toBe("critical");
    expect(memory.stateSince).toBe(90_000);

    memory = advancePressureState(memory, sample(90_001, 50), "balanced");
    expect(memory.recoverySince).toBe(90_001);
    memory = advancePressureState(memory, sample(390_001, 50), "balanced");
    expect(memory.pressure).toBe("recovering");

    memory = advancePressureState(memory, sample(690_001, 50), "balanced");
    expect(memory.pressure).toBe("healthy");
    expect(memory).toEqual({
      pressure: "healthy",
      stateSince: 690_001,
      elevatedSince: null,
      criticalSince: null,
      emergencySince: null,
      thermalSince: null,
      recoverySince: null,
    });
  });

  it("tracks the emergency CPU window independently from the critical window", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 97), "balanced");
    memory = advancePressureState(memory, sample(90_000, 97), "balanced");
    expect(memory.pressure).toBe("critical");

    memory = advancePressureState(memory, sample(180_000, 97), "balanced");
    expect(memory.pressure).toBe("emergency");
    expect(memory.criticalSince).toBe(0);
    expect(memory.emergencySince).toBe(0);
  });

  it("treats sustained host load as pressure even when CPU usage is modest", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sampleWithLoad(0, 55, 220), "balanced");
    memory = advancePressureState(memory, sampleWithLoad(60_000, 55, 220), "balanced");
    expect(memory.pressure).toBe("elevated");

    memory = advancePressureState(memory, sampleWithLoad(90_000, 55, 220), "balanced");
    expect(memory.pressure).toBe("critical");

    memory = advancePressureState(memory, sampleWithLoad(90_001, 55, 220), "balanced");
    expect(memory.pressure).toBe("critical");
    expect(memory.recoverySince).toBeNull();
  });

  it("closes admission when event loop lag exceeds the control request window", () => {
    const memory = advancePressureState(
      initialPressureMemory(0),
      sampleWithEventLoopLag(30_001, 30_001),
      "balanced",
    );

    expect(memory.pressure).toBe("critical");
    expect(memory.stateSince).toBe(30_001);
  });

  it("does not enter recovering before the recovery window while event loop lag remains severe", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 94), "balanced");
    memory = advancePressureState(memory, sample(90_000, 94), "balanced");
    expect(memory.pressure).toBe("critical");

    memory = advancePressureState(memory, sampleWithEventLoopLag(390_000, 45_000), "balanced");

    expect(memory.pressure).toBe("critical");
    expect(memory.recoverySince).toBe(390_000);
  });

  it("keeps low-resource recovery progress across isolated control-loop lag", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 94), "balanced");
    memory = advancePressureState(memory, sample(90_000, 94), "balanced");
    expect(memory.pressure).toBe("critical");

    memory = advancePressureState(memory, sample(90_001, 40), "balanced");
    expect(memory.recoverySince).toBe(90_001);

    memory = advancePressureState(memory, sampleWithEventLoopLag(240_001, 45_000), "balanced");
    expect(memory.pressure).toBe("critical");
    expect(memory.recoverySince).toBe(90_001);

    memory = advancePressureState(memory, sample(390_001, 40), "balanced");
    expect(memory.pressure).toBe("recovering");
    expect(memory.recoverySince).toBe(90_001);
  });

  it("does not reopen fully healthy while control-loop lag is still severe", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 94), "balanced");
    memory = advancePressureState(memory, sample(90_000, 94), "balanced");
    memory = advancePressureState(memory, sample(90_001, 40), "balanced");
    memory = advancePressureState(memory, sample(390_001, 40), "balanced");
    expect(memory.pressure).toBe("recovering");

    memory = advancePressureState(memory, sampleWithEventLoopLag(690_001, 45_000), "balanced");

    expect(memory.pressure).toBe("recovering");
    expect(memory.recoverySince).toBe(90_001);
  });

  it("enters emergency after sustained thermal pressure", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 20, "pressure"), "balanced");
    memory = advancePressureState(memory, sample(14_999, 20, "pressure"), "balanced");
    expect(memory.pressure).toBe("healthy");

    memory = advancePressureState(memory, sample(15_000, 20, "pressure"), "balanced");
    expect(memory.pressure).toBe("emergency");
    expect(memory.thermalSince).toBe(0);
  });

  it("does not open recovery after the recovery threshold interrupts recovering", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 94), "balanced");
    memory = advancePressureState(memory, sample(90_000, 94), "balanced");
    memory = advancePressureState(memory, sample(90_001, 50), "balanced");
    memory = advancePressureState(memory, sample(390_001, 50), "balanced");
    expect(memory.pressure).toBe("recovering");

    memory = advancePressureState(memory, sample(400_000, 70), "balanced");
    expect(memory.pressure).toBe("critical");
    expect(memory.recoverySince).toBeNull();

    memory = advancePressureState(memory, sample(690_001, 50), "balanced");
    expect(memory.pressure).toBe("critical");
    expect(memory.recoverySince).toBe(690_001);
  });

  it("clears an interrupted recovery clock when emergency pressure returns", () => {
    let memory = initialPressureMemory(0);
    memory = advancePressureState(memory, sample(0, 94), "balanced");
    memory = advancePressureState(memory, sample(90_000, 94), "balanced");
    memory = advancePressureState(memory, sample(90_001, 50), "balanced");
    memory = advancePressureState(memory, sample(390_001, 50), "balanced");
    expect(memory.pressure).toBe("recovering");

    memory = advancePressureState(memory, sample(390_002, 97), "balanced");
    memory = advancePressureState(memory, sample(480_002, 97), "balanced");
    memory = advancePressureState(memory, sample(570_002, 97), "balanced");
    expect(memory.pressure).toBe("emergency");
    expect(memory.recoverySince).toBeNull();

    memory = advancePressureState(memory, sample(570_003, 50), "balanced");
    memory = advancePressureState(memory, sample(870_002, 50), "balanced");
    expect(memory.pressure).toBe("emergency");
    memory = advancePressureState(memory, sample(870_003, 50), "balanced");
    expect(memory.pressure).toBe("recovering");
    memory = advancePressureState(memory, sample(1_170_002, 50), "balanced");
    expect(memory.pressure).toBe("recovering");
    memory = advancePressureState(memory, sample(1_170_003, 50), "balanced");
    expect(memory.pressure).toBe("healthy");
  });

  it("keeps transitions pure and pressure profiles frozen", () => {
    const previous = initialPressureMemory(0);
    const snapshot = { ...previous };

    const next = advancePressureState(previous, sample(60_000, 85), "balanced");

    expect(previous).toEqual(snapshot);
    expect(next).not.toBe(previous);
    expect(Object.isFrozen(PRESSURE_PROFILES)).toBe(true);
    expect(Object.isFrozen(PRESSURE_PROFILES.balanced)).toBe(true);
  });

  it("uses distinct conservative thresholds", () => {
    let balanced = advancePressureState(initialPressureMemory(0), sample(0, 76), "balanced");
    let conservative = advancePressureState(
      initialPressureMemory(0),
      sample(0, 76),
      "conservative",
    );
    balanced = advancePressureState(balanced, sample(60_000, 76), "balanced");
    conservative = advancePressureState(conservative, sample(60_000, 76), "conservative");
    expect(balanced.pressure).toBe("healthy");
    expect(conservative.pressure).toBe("elevated");

    balanced = advancePressureState(
      advancePressureState(initialPressureMemory(0), sample(0, 90), "balanced"),
      sample(90_000, 90),
      "balanced",
    );
    conservative = advancePressureState(
      advancePressureState(initialPressureMemory(0), sample(0, 90), "conservative"),
      sample(90_000, 90),
      "conservative",
    );
    expect(balanced.pressure).toBe("elevated");
    expect(conservative.pressure).toBe("critical");
    expect(PRESSURE_PROFILES.balanced.criticalCpuPct).not.toBe(
      PRESSURE_PROFILES.conservative.criticalCpuPct,
    );
  });
});
