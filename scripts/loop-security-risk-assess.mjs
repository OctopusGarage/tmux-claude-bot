#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function output(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function dependencyAuditUnavailable(message) {
  output({
    failureKind: "dependency-audit-unavailable",
    retryable: true,
    findings: [],
    suggestedBotImprovements: [message],
  });
  process.exitCode = 2;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonStdout(result) {
  if (typeof result.stdout !== "string" || result.stdout.trim() === "") return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function javascriptVulnerabilities(report) {
  if (!isRecord(report) || !isRecord(report.metadata) || !isRecord(report.metadata.vulnerabilities))
    return undefined;
  const counts = report.metadata.vulnerabilities;
  const required = ["critical", "high", "moderate", "low"];
  if (
    !required.every(
      (severity) =>
        typeof counts[severity] === "number" &&
        Number.isFinite(counts[severity]) &&
        counts[severity] >= 0,
    )
  )
    return undefined;
  return counts;
}

function pythonVulnerabilities(report) {
  if (
    !Array.isArray(report) ||
    report.length === 0 ||
    !report.every(
      (dependency) =>
        isRecord(dependency) &&
        typeof dependency.name === "string" &&
        dependency.name.length > 0 &&
        typeof dependency.version === "string" &&
        dependency.version.length > 0 &&
        Array.isArray(dependency.vulns) &&
        dependency.vulns.every(
          (vulnerability) =>
            isRecord(vulnerability) &&
            typeof vulnerability.id === "string" &&
            vulnerability.id.length > 0,
        ),
    )
  )
    return undefined;
  return report.flatMap((dependency) => dependency.vulns);
}

function javascriptRisk(projectPath, command, args) {
  const result = run(command, args, projectPath);
  const vulnerabilities = javascriptVulnerabilities(parseJsonStdout(result));
  if (vulnerabilities === undefined) {
    dependencyAuditUnavailable(`${command} audit did not return valid vulnerability metadata`);
    return;
  }
  const critical = vulnerabilities.critical;
  const high = vulnerabilities.high;
  const moderate = vulnerabilities.moderate;
  const low = vulnerabilities.low;
  const riskScore = critical > 0 ? 100 : high >= 3 ? 90 : high > 0 ? 85 : moderate > 0 ? 60 : low > 0 ? 30 : 0;
  output({
    riskScore,
    critical: critical > 0,
    findings: [
      critical > 0 ? `${command} audit reports ${critical} critical vulnerability(s)` : "",
      high > 0 ? `${command} audit reports ${high} high vulnerability(s)` : "",
      moderate > 0 ? `${command} audit reports ${moderate} moderate vulnerability(s)` : "",
      low > 0 ? `${command} audit reports ${low} low vulnerability(s)` : "",
    ].filter(Boolean),
  });
}

function pipAuditRisk(projectPath) {
  const projectExecutable = join(projectPath, ".venv", "bin", "pip-audit");
  const lookup = existsSync(projectExecutable)
    ? undefined
    : run("sh", ["-lc", "command -v pip-audit"], projectPath);
  const executable = existsSync(projectExecutable)
    ? projectExecutable
    : lookup?.status === 0 &&
        lookup.signal === null &&
        lookup.error === undefined &&
        typeof lookup.stdout === "string"
      ? lookup.stdout.trim()
      : "";
  if (executable.length === 0) {
    dependencyAuditUnavailable("pip-audit is not installed in the target environment");
    return;
  }
  const result = run(executable, ["--format", "json"], projectPath);
  const vulnerabilities = pythonVulnerabilities(parseJsonStdout(result));
  if (vulnerabilities === undefined) {
    dependencyAuditUnavailable("pip-audit did not return valid dependency metadata");
    return;
  }
  output({
    riskScore: vulnerabilities.length > 3 ? 90 : vulnerabilities.length > 0 ? 85 : 0,
    findings: vulnerabilities.map((item) => `${item.id ?? "unknown vulnerability"}`).slice(0, 20),
  });
}

const projectPath = process.env.LOOP_PROJECT_PATH ?? process.cwd();
if (existsSync(join(projectPath, "package-lock.json")) || existsSync(join(projectPath, "npm-shrinkwrap.json"))) {
  javascriptRisk(projectPath, "npm", ["audit", "--json", "--omit=dev"]);
} else if (existsSync(join(projectPath, "pnpm-lock.yaml"))) {
  javascriptRisk(projectPath, "pnpm", ["audit", "--json", "--prod"]);
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
