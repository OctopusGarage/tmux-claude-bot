import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitFromCircuit, admitResourceWork } from "../../src/core/resource-guardian/admission.js";
import { createResourceGuardianStore } from "../../src/core/resource-guardian/store.js";
import type {
  ResourceAdmissionInput,
  ResourceCircuitState,
  ResourceGuardianOperatorState,
  ResourceGuardianView,
  ResourceIncident,
} from "../../src/core/resource-guardian/types.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-guardian-"));
  temporaryRoots.push(root);
  return root;
}

const clock = () => 1_700_000_000_000;

function circuit(overrides: Partial<ResourceCircuitState> = {}): ResourceCircuitState {
  return {
    schemaVersion: 1,
    pressure: "healthy",
    incidentId: null,
    admission: "open",
    reason: "steady",
    changedAt: clock(),
    lastSampleAt: clock(),
    owner: "resource-guardian",
    ...overrides,
  };
}

function view(overrides: Partial<ResourceGuardianView> = {}): ResourceGuardianView {
  return {
    enabled: true,
    mode: "protect",
    profile: "balanced",
    pressure: "healthy",
    circuit: "open",
    incidentId: null,
    reason: "steady",
    attribution: "unknown",
    latestSample: null,
    ...overrides,
  };
}

function input(overrides: Partial<ResourceAdmissionInput> = {}): ResourceAdmissionInput {
  return {
    source: "loop-engineering",
    trigger: "background",
    weight: "heavy",
    now: clock(),
    ...overrides,
  };
}

function incident(id: string, startedAt: number, endedAt?: number): ResourceIncident {
  return {
    schemaVersion: 1,
    id,
    fingerprint: `fp-${id}`,
    attribution: "unknown",
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    pressure: "critical",
    samples: [],
    transitions: [],
    actions: [],
  };
}

describe("resource guardian durable store", () => {
  it("returns an unwritten degraded observe/open state when state is absent", () => {
    const rootDir = tempRoot();
    const store = createResourceGuardianStore({ rootDir, now: clock });

    const current = store.readCurrent();

    expect(current.degraded).toBe(true);
    expect(current.view).toMatchObject({ enabled: false, mode: "observe", circuit: "open" });
    expect(current.circuit).toMatchObject({ admission: "open", owner: "resource-guardian" });
    expect(fs.existsSync(store.paths.state)).toBe(false);
  });

  it("round-trips current state through an atomic state file", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    const current = {
      circuit: circuit({ pressure: "critical", admission: "heavy-closed" }),
      view: view({ pressure: "critical", circuit: "heavy-closed" }),
    };

    store.writeCurrent(current);

    expect(store.readCurrent()).toEqual({ ...current, degraded: false });
    expect(JSON.parse(fs.readFileSync(store.paths.state, "utf8"))).toEqual(current);
  });

  it("re-reads an externally replaced circuit for every admission", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    store.writeCurrent({ circuit: circuit({ admission: "open" }), view: view() });

    expect(admitResourceWork(input(), store).allowed).toBe(true);
    fs.writeFileSync(
      store.paths.state,
      JSON.stringify({
        circuit: circuit({ admission: "background-closed" }),
        view: view({ circuit: "background-closed" }),
      }),
    );

    expect(admitResourceWork(input(), store)).toMatchObject({
      allowed: false,
      reason: "steady",
    });
  });

  it("does not write state or increment attempts when background heavy work is closed", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    store.writeCurrent({
      circuit: circuit({ admission: "background-closed" }),
      view: view({ circuit: "background-closed" }),
    });
    const before = fs.readFileSync(store.paths.state, "utf8");

    expect(admitResourceWork(input(), store).allowed).toBe(false);
    expect(fs.readFileSync(store.paths.state, "utf8")).toBe(before);
  });

  it("quarantines invalid state bytes and returns a degraded observe view", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    fs.mkdirSync(path.dirname(store.paths.state), { recursive: true });
    fs.writeFileSync(store.paths.state, "{not json");

    const current = store.readCurrent();

    expect(current).toMatchObject({
      degraded: true,
      view: { mode: "observe", enabled: false },
      circuit: { admission: "background-closed" },
    });
    expect(fs.existsSync(store.paths.state)).toBe(false);
    expect(fs.readFileSync(`${store.paths.state}.corrupt-${clock()}`, "utf8")).toBe("{not json");
  });

  it("uses a deterministic safe suffix when a state quarantine name already exists", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    const originalQuarantine = `${store.paths.state}.corrupt-${clock()}`;
    fs.mkdirSync(path.dirname(store.paths.state), { recursive: true });
    fs.writeFileSync(originalQuarantine, "previous corrupt bytes");
    fs.writeFileSync(store.paths.state, "new corrupt bytes");

    expect(store.readCurrent().degraded).toBe(true);

    expect(fs.existsSync(store.paths.state)).toBe(false);
    expect(fs.readFileSync(originalQuarantine, "utf8")).toBe("previous corrupt bytes");
    expect(fs.readFileSync(`${originalQuarantine}-1`, "utf8")).toBe("new corrupt bytes");
  });

  it("quarantines schema-invalid state without overwriting its bytes", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    fs.mkdirSync(path.dirname(store.paths.state), { recursive: true });
    fs.writeFileSync(
      store.paths.state,
      JSON.stringify({ circuit: { schemaVersion: 2 }, view: {} }),
    );

    expect(store.readCurrent().degraded).toBe(true);
    expect(fs.readFileSync(`${store.paths.state}.corrupt-${clock()}`, "utf8")).toContain(
      '"schemaVersion":2',
    );
  });

  it("round-trips operator state and safely ignores corrupt operator overrides", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    const operator: ResourceGuardianOperatorState = {
      schemaVersion: 1,
      mode: "protect",
      profile: "conservative",
      updatedAt: clock(),
    };

    expect(store.readOperator()).toBeNull();
    store.writeOperator(operator);
    expect(store.readOperator()).toEqual(operator);
    fs.writeFileSync(store.paths.operator, "not-json");

    expect(store.readOperator()).toBeNull();
    expect(fs.existsSync(`${store.paths.operator}.corrupt-${clock()}`)).toBe(true);
  });

  it("rejects invalid operator and incident records before writing", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    const invalidOperator = {
      schemaVersion: 2,
      mode: "protect",
      profile: "balanced",
      updatedAt: clock(),
    } as unknown as ResourceGuardianOperatorState;
    const invalidIncident = {
      ...incident("invalid", clock()),
      schemaVersion: 2,
    } as unknown as ResourceIncident;

    expect(() => store.writeOperator(invalidOperator)).toThrow(
      "Invalid resource guardian operator state",
    );
    expect(() => store.writeIncident(invalidIncident)).toThrow(
      "Invalid resource guardian incident",
    );
    expect(fs.existsSync(store.paths.operator)).toBe(false);
    expect(fs.existsSync(path.join(store.paths.incidents, "invalid.json"))).toBe(false);
  });

  it("prunes oldest incident records by end/start time and id while ignoring irrelevant entries", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    fs.mkdirSync(store.paths.incidents, { recursive: true });
    const writeIncidentFile = (record: ResourceIncident): void => {
      fs.writeFileSync(
        path.join(store.paths.incidents, `${record.id}.json`),
        JSON.stringify(record),
      );
    };
    writeIncidentFile(incident("z-ended-first", 500, -1));
    writeIncidentFile(incident("a-same-time", 0));
    writeIncidentFile(incident("z-same-time", 0));
    for (let index = 0; index < 49; index += 1)
      writeIncidentFile(incident(`incident-${index}`, 1_000 + index));
    fs.mkdirSync(path.join(store.paths.incidents, "nested"), { recursive: true });
    fs.writeFileSync(path.join(store.paths.incidents, "note.txt"), "keep");

    store.pruneIncidents();

    const names = fs.readdirSync(store.paths.incidents);
    expect(names).toContain("note.txt");
    expect(names).toContain("nested");
    expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(50);
    expect(names).not.toContain("z-ended-first.json");
    expect(names).not.toContain("a-same-time.json");
    expect(names).toContain("z-same-time.json");
  });

  it("uses filename as the final deterministic retention tie-break", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    fs.mkdirSync(store.paths.incidents, { recursive: true });
    const tie = incident("same-id", 0);
    fs.writeFileSync(path.join(store.paths.incidents, "b-tie.json"), JSON.stringify(tie));
    fs.writeFileSync(path.join(store.paths.incidents, "a-tie.json"), JSON.stringify(tie));
    for (let index = 0; index < 49; index += 1) {
      const record = incident(`later-${index}`, index + 1);
      fs.writeFileSync(
        path.join(store.paths.incidents, `${record.id}.json`),
        JSON.stringify(record),
      );
    }

    store.pruneIncidents();

    expect(fs.existsSync(path.join(store.paths.incidents, "a-tie.json"))).toBe(false);
    expect(fs.existsSync(path.join(store.paths.incidents, "b-tie.json"))).toBe(true);
  });

  it("prunes by total incident bytes and lets corrupt incidents be removed without affecting current protection", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    store.writeCurrent({
      circuit: circuit({ admission: "heavy-closed" }),
      view: view({ circuit: "heavy-closed" }),
    });
    fs.mkdirSync(store.paths.incidents, { recursive: true });
    fs.writeFileSync(
      path.join(store.paths.incidents, "corrupt.json"),
      "x".repeat(10 * 1024 * 1024 + 1),
    );
    store.writeIncident(incident("new", clock()));

    store.pruneIncidents();

    expect(fs.existsSync(path.join(store.paths.incidents, "corrupt.json"))).toBe(false);
    expect(store.readCurrent().circuit.admission).toBe("heavy-closed");
  });

  it("rejects inconsistent whole-current writes", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });

    expect(() =>
      store.writeCurrent({
        circuit: circuit({ admission: "heavy-closed" }),
        view: view({ circuit: "open" }),
      }),
    ).toThrow("Invalid resource guardian current state");
    expect(fs.existsSync(store.paths.state)).toBe(false);
  });

  it("treats malformed deep sample processes as corrupt current state", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    const current = {
      circuit: circuit(),
      view: {
        ...view(),
        latestSample: {
          capturedAt: clock(),
          hostCpuPct: 1,
          loadPct: 1,
          eventLoopLagMs: 1,
          thermal: "normal",
          deepSnapshot: {
            capturedAt: clock(),
            thermal: "normal",
            processes: [
              {
                pid: "not-a-pid",
                ppid: 1,
                pgid: 1,
                startedAt: "now",
                cpuPct: 1,
                rssKb: 1,
                command: "x",
              },
            ],
          },
        },
      },
    };
    fs.mkdirSync(path.dirname(store.paths.state), { recursive: true });
    fs.writeFileSync(store.paths.state, JSON.stringify(current));

    expect(store.readCurrent()).toMatchObject({
      degraded: true,
      circuit: { admission: "background-closed" },
    });
  });
});

describe("resource guardian admission", () => {
  it("does not mutate corrupt state while admitting background work", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    fs.mkdirSync(path.dirname(store.paths.state), { recursive: true });
    fs.writeFileSync(store.paths.state, "{not json");
    const beforeNames = fs.readdirSync(path.dirname(store.paths.state));
    const beforeBytes = fs.readFileSync(store.paths.state, "utf8");
    const beforeMtime = fs.statSync(store.paths.state).mtimeMs;

    expect(admitResourceWork(input(), store)).toMatchObject({
      allowed: false,
      reason: "resource guardian state is invalid; observing with background work closed",
    });
    expect(fs.readdirSync(path.dirname(store.paths.state))).toEqual(beforeNames);
    expect(fs.readFileSync(store.paths.state, "utf8")).toBe(beforeBytes);
    expect(fs.statSync(store.paths.state).mtimeMs).toBe(beforeMtime);

    expect(store.readCurrent().degraded).toBe(true);
    expect(fs.existsSync(store.paths.state)).toBe(false);
    expect(fs.readFileSync(`${store.paths.state}.corrupt-${clock()}`, "utf8")).toBe(beforeBytes);
  });

  it("keeps corrupt evidence closed after an explicit quarantine without admission writes", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    fs.mkdirSync(path.dirname(store.paths.state), { recursive: true });
    fs.writeFileSync(store.paths.state, "{not json");
    expect(store.readCurrent().degraded).toBe(true);
    const beforeNames = fs.readdirSync(path.dirname(store.paths.state));

    expect(admitResourceWork(input(), store)).toMatchObject({
      allowed: false,
      reason: "resource guardian state is invalid; observing with background work closed",
    });
    expect(fs.readdirSync(path.dirname(store.paths.state))).toEqual(beforeNames);
  });

  it("always allows interactive and reconcile work", () => {
    for (const trigger of ["interactive", "reconcile"] as const) {
      expect(
        admitFromCircuit(input({ trigger }), circuit({ admission: "background-closed" })).allowed,
      ).toBe(true);
    }
  });

  it("allows an open circuit", () => {
    expect(admitFromCircuit(input(), circuit({ admission: "open" })).allowed).toBe(true);
  });

  it("treats an explicitly open circuit as authoritative during emergency", () => {
    expect(
      admitFromCircuit(
        input({ trigger: "operator", forced: true }),
        circuit({ pressure: "emergency", admission: "open", reason: "operator left open" }),
      ),
    ).toMatchObject({ allowed: true, reason: "open" });
  });

  it("uses the circuit reason for every non-exempt denial", () => {
    expect(
      admitFromCircuit(
        input({ trigger: "operator", forced: true }),
        circuit({
          pressure: "emergency",
          admission: "background-closed",
          reason: "thermal emergency",
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "thermal emergency" });
    expect(
      admitFromCircuit(
        input(),
        circuit({ admission: "background-closed", reason: "capacity held" }),
      ),
    ).toMatchObject({ allowed: false, reason: "capacity held" });
  });

  it("allows a forced operator request outside emergency", () => {
    expect(
      admitFromCircuit(
        input({ trigger: "operator", forced: true }),
        circuit({ admission: "background-closed" }),
      ).allowed,
    ).toBe(true);
  });

  it("allows light work but denies heavy work on a heavy-closed circuit", () => {
    expect(
      admitFromCircuit(input({ weight: "light" }), circuit({ admission: "heavy-closed" })).allowed,
    ).toBe(true);
    expect(
      admitFromCircuit(input({ weight: "heavy" }), circuit({ admission: "heavy-closed" })).allowed,
    ).toBe(false);
  });

  it("keeps a configured observe-mode state open for admission", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    store.writeCurrent({
      circuit: circuit({ admission: "open" }),
      view: view({ mode: "observe", circuit: "open" }),
    });

    expect(admitResourceWork(input(), store)).toMatchObject({ allowed: true, reason: "observe" });
  });

  it("treats an inconsistent observe view as corrupt instead of allowing it", () => {
    const store = createResourceGuardianStore({ rootDir: tempRoot(), now: clock });
    fs.mkdirSync(path.dirname(store.paths.state), { recursive: true });
    fs.writeFileSync(
      store.paths.state,
      JSON.stringify({
        circuit: circuit({ admission: "background-closed", reason: "capacity held" }),
        view: view({ mode: "observe", circuit: "background-closed", reason: "capacity held" }),
      }),
    );

    expect(admitResourceWork(input(), store)).toMatchObject({
      allowed: false,
      reason: "resource guardian state is invalid; observing with background work closed",
    });
  });
});
