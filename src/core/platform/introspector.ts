/**
 * OS-specific process introspection, funnelled to one small interface so the
 * rest of the codebase never branches on platform. macOS uses ps/lsof; Linux
 * reads /proc. Selected once via process.platform.
 *
 * The contract types live in ./introspector.types.js (a leaf module) so the
 * platform implementations can import them without cycling back through this
 * module, which imports those implementations for selectIntrospector().
 */

import { createDarwinIntrospector } from "./introspector.darwin.js";
import { createLinuxIntrospector } from "./introspector.linux.js";
import type { ProcessIntrospector } from "./introspector.types.js";

export type { ProcessIntrospector, ProcRow } from "./introspector.types.js";

/** Pick the introspector for the current OS. Non-linux falls through to darwin
 * (this project supports only macOS and Linux). */
export function selectIntrospector(): ProcessIntrospector {
  return process.platform === "linux" ? createLinuxIntrospector() : createDarwinIntrospector();
}
