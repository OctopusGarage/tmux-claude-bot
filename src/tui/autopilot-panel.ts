import type { AutopilotView } from "../core/autopilot/autopilot-view.js";

export { goalsVerb } from "../core/autopilot/controls.js";

export type ApAction =
  | { key: "toggle"; label: string; verb: string }
  | { key: "pick"; label: string }
  | { key: "global"; label: string; verb: string }
  | { key: "stop"; label: string; verb: string }
  | { key: "confirm"; label: string; verb: string }
  | { key: "continue"; label: string; verb: string };

/** The selectable action rows of the TUI autopilot panel, derived from the view.
 * Labels are plain ASCII (the TUI is a local operator surface; not i18n-rendered).
 * Progressive disclosure mirrors the chat panels. */
export function autopilotActionList(view: AutopilotView): ApAction[] {
  const out: ApAction[] = [];
  if (view.gatePending) {
    out.push({ key: "confirm", label: "Confirm done", verb: "confirm" });
    out.push({ key: "continue", label: "Keep going", verb: "reject" });
  }
  if (!view.enabled) {
    out.push({ key: "toggle", label: "Enable autopilot", verb: "on" });
    return out;
  }
  out.push({ key: "toggle", label: "Disable autopilot", verb: "off" });
  out.push({ key: "pick", label: "Pick goals..." });
  out.push({
    key: "global",
    label: view.globalOn ? "Global: on" : "Global: off",
    verb: view.globalOn ? "global off" : "global on",
  });
  if (view.mode === "cycle") out.push({ key: "stop", label: "Stop goal", verb: "stop" });
  return out;
}
