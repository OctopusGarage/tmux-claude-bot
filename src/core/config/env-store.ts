import { existsSync, readFileSync } from "node:fs";
import { appStateFile } from "../../shared/state-dir.js";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { parseEnv, serializeEnv } from "../infra/onboarding.js";

/** Durable .env access shared by safe configuration and Automation policy. */
export function readConfigEnvironment(): Map<string, string> {
  return parseEnv(readConfigEnvironmentText());
}

export function writeConfigEnvironment(values: Record<string, string>): void {
  writeFileAtomicSync(configEnvironmentPath(), serializeEnv(readConfigEnvironmentText(), values), {
    mode: 0o600,
  });
}

function configEnvironmentPath(): string {
  return appStateFile(".env");
}

function readConfigEnvironmentText(): string {
  const path = configEnvironmentPath();
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
