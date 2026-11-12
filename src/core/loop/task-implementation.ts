/** Metadata for the task families with explicitly selectable implementations. */
export const TASK_IMPLEMENTATIONS = {
  architecture: {
    configKey: "architecture",
    profile: "builtin:architecture",
    report: "ARCHITECTURE_REPORT.md",
    label: "architecture",
  },
  "bug-fix": {
    configKey: "bugFix",
    profile: "builtin:bugfix",
    report: "BUGFIX_REPORT.md",
    label: "bugfix",
  },
  "test-coverage": {
    configKey: "testCoverage",
    profile: "builtin:test-coverage",
    report: "COVERAGE_REPORT.md",
    label: "test-coverage",
  },
  "security-maintenance": {
    configKey: "securityMaintenance",
    profile: "builtin:security-maintenance",
    report: "SECURITY_REPORT.md",
    label: "security-maintenance",
  },
} as const;

export type TaskImplementationKind = keyof typeof TASK_IMPLEMENTATIONS;
