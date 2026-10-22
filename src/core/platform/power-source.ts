import { execFileSync } from "node:child_process";

export type MacPowerSource = "ac" | "battery" | "unknown" | "unsupported";

export function parseMacPowerSource(output: string): MacPowerSource {
  if (/drawing from ['"]AC Power['"]/i.test(output)) return "ac";
  if (/drawing from ['"]Battery Power['"]/i.test(output)) return "battery";
  return "unknown";
}

/** Read the current source without mutating host power policy or requesting privileges. */
export function readMacPowerSource(): MacPowerSource {
  if (process.platform !== "darwin") return "unsupported";
  try {
    return parseMacPowerSource(
      execFileSync("pmset", ["-g", "batt"], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      }),
    );
  } catch {
    return "unknown";
  }
}
