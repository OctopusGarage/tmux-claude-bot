/**
 * Health check for an installed bot. Prints a ✓/✗ checklist and exits non-zero
 * if anything is wrong — notably MORE THAN ONE bot process (the documented 409
 * single-instance trap). Run via `npm run doctor`.
 *
 * Check logic lives in core/doctor.ts (shared with the /doctor chat command);
 * this wrapper only renders with ANSI colors — including sensitive details
 * the chat rendering redacts — and sets the exit code.
 */
import { defaultProbes, runDoctorChecks } from "../core/doctor.js";

const PREFIX = {
  ok: "\x1b[1;32m✓\x1b[0m",
  bad: "\x1b[1;31m✗\x1b[0m",
  info: "\x1b[1;34mi\x1b[0m",
} as const;

async function main(): Promise<void> {
  const report = await runDoctorChecks(defaultProbes());

  for (const c of report.checks) {
    const detail = c.sensitiveDetail ? ` (${c.sensitiveDetail})` : "";
    console.log(`${PREFIX[c.status]} ${c.text}${detail}`);
    if (c.fix) console.log(`   fix: ${c.fix}`);
  }

  console.log(
    report.failures === 0
      ? "\n\x1b[1;32mAll checks passed.\x1b[0m"
      : `\n\x1b[1;31m${report.failures} check(s) failed.\x1b[0m`,
  );
  process.exit(report.failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
