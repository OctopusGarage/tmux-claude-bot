#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function output(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function npmRisk(projectPath) {
  const result = run("npm", ["audit", "--json", "--omit=dev"], projectPath);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    output({
      findings: [],
      suggestedBotImprovements: ["npm audit did not return valid JSON"],
    });
    process.exitCode = 2;
    return;
  }
  const vulnerabilities = report.metadata?.vulnerabilities ?? {};
  const critical = Number(vulnerabilities.critical ?? 0);
  const high = Number(vulnerabilities.high ?? 0);
  const moderate = Number(vulnerabilities.moderate ?? 0);
  const low = Number(vulnerabilities.low ?? 0);
  const riskScore = critical > 0 ? 100 : high >= 3 ? 90 : high > 0 ? 85 : moderate > 0 ? 60 : low > 0 ? 30 : 0;
  output({
    riskScore,
    critical: critical > 0,
    findings: [
      critical > 0 ? `npm audit reports ${critical} critical vulnerability(s)` : "",
      high > 0 ? `npm audit reports ${high} high vulnerability(s)` : "",
      moderate > 0 ? `npm audit reports ${moderate} moderate vulnerability(s)` : "",
      low > 0 ? `npm audit reports ${low} low vulnerability(s)` : "",
    ].filter(Boolean),
  });
}

function pipAuditRisk(projectPath) {
  const executable = run("sh", ["-lc", "command -v pip-audit"], projectPath);
  if (executable.status !== 0) {
    output({
      findings: [],
      suggestedBotImprovements: ["pip-audit is not installed in the target environment"],
    });
    process.exitCode = 2;
    return;
  }
  const result = run("pip-audit", ["--format", "json"], projectPath);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    output({
      findings: [],
      suggestedBotImprovements: ["pip-audit did not return valid JSON"],
    });
    process.exitCode = 2;
    return;
  }
  const vulnerabilities = Array.isArray(report)
    ? report.flatMap((item) => (Array.isArray(item.vulns) ? item.vulns : []))
    : [];
  output({
    riskScore: vulnerabilities.length > 3 ? 90 : vulnerabilities.length > 0 ? 85 : 0,
    findings: vulnerabilities.map((item) => `${item.id ?? "unknown vulnerability"}`).slice(0, 20),
  });
}

const projectPath = process.env.LOOP_PROJECT_PATH ?? process.cwd();
if (existsSync(join(projectPath, "package-lock.json")) || existsSync(join(projectPath, "npm-shrinkwrap.json"))) {
  npmRisk(projectPath);
} else if (
  existsSync(join(projectPath, "pyproject.toml")) ||
  existsSync(join(projectPath, "requirements.txt")) ||
  existsSync(join(projectPath, "Pipfile.lock"))
) {
  pipAuditRisk(projectPath);
} else {
  output({
    findings: [],
    suggestedBotImprovements: ["no supported dependency security manifest was found"],
  });
  process.exitCode = 2;
}
