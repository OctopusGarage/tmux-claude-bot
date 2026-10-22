import { appStateDir } from "../../shared/state-dir.js";
import type { ResourceGuardianStore } from "./store.js";
import { createResourceGuardianStore } from "./store.js";
import type { ResourceAdmission, ResourceAdmissionInput, ResourceCircuitState } from "./types.js";

function decision(
  allowed: boolean,
  reason: string,
  circuit: ResourceCircuitState,
): ResourceAdmission {
  return { allowed, reason, incidentId: circuit.incidentId };
}

/** Maps a caller's request to the current circuit without causing any state changes. */
export function admitFromCircuit(
  input: ResourceAdmissionInput,
  circuit: ResourceCircuitState,
): ResourceAdmission {
  if (input.trigger === "interactive" || input.trigger === "reconcile") {
    return decision(true, input.trigger, circuit);
  }
  if (circuit.admission === "open") return decision(true, "open", circuit);
  if (circuit.pressure === "emergency") return decision(false, circuit.reason, circuit);
  if (input.trigger === "operator" && input.forced)
    return decision(true, "operator-forced", circuit);
  if (circuit.admission === "heavy-closed" && input.weight === "light") {
    return decision(true, "heavy-closed-light", circuit);
  }
  return decision(false, circuit.reason, circuit);
}

/** Reads the on-disk state on every call. Admission is intentionally read-only. */
export function admitResourceWork(
  input: ResourceAdmissionInput,
  store: Pick<ResourceGuardianStore, "readCurrentReadOnly"> = createResourceGuardianStore({
    stateDir: appStateDir(),
  }),
): ResourceAdmission {
  const current = store.readCurrentReadOnly();
  if (!current.degraded && current.view.mode === "observe") {
    return { allowed: true, reason: "observe", incidentId: current.circuit.incidentId };
  }
  return admitFromCircuit(input, current.circuit);
}
