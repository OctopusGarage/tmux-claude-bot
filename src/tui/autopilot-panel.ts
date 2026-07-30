export type ApAction = { key: "delegate"; label: string; verb: string };

/** TUI Autopilot now exposes only supervisor-backed delegation. */
export function autopilotActionList(): ApAction[] {
  return [{ key: "delegate", label: "Continue via supervisor", verb: "delegate" }];
}
