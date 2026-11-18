import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const advisory = "GHSA-fc5q-39xc-vjpf";
const patchHash = "f8562132ea07d803714990e4217e05c408b91faa49293553df9f21f88cff7adc";
const sourceHash = "031fc058cd0c7a44b27325caeec355cd9305807c500c50f7ab65d0d754cc2024";
const script = fileURLToPath(import.meta.url);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function probePicomatch(path) {
  const pm = createRequire(import.meta.url)(path);
  for (const pattern of ["+(*)", "*(*)", "+(*a)", "*(*a)", "+(**a)", "+(@(*a))", "+([[]*a)", "+([*a)", "+(*a|b)"]) {
    // Matching must finish within the parent process's hard deadline.
    assert.equal(pm.isMatch(`${"a".repeat(48)}/`, pattern), false, pattern);
    assert.equal(pm.isMatch(`${"a".repeat(48)}!`, `${pattern}b`), false, pattern);
  }
  for (const [subject, pattern, matches] of [
    ["src/nested/file.ts", "src/**/*.ts", true],
    ["src/file.js", "src/**/*.ts", false],
    ["file.ts", "*.{js,ts}", true],
    ["foofoo", "+(foo)", true],
    ["foobar", "*(foo|bar)", true],
    ["aaabbb", "+(*(a)|*(b))", true],
    ["***", "+([*])", true],
    ["***", "+(\\*)", true],
    ["***", '+("*")', true],
    ["file.ts", "!(*.js)", true],
  ]) {
    assert.equal(pm.isMatch(subject, pattern), matches, `${subject}: ${pattern}`);
  }
}

export function verifyPicomatch(root, tree) {
  const config = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const patch = "patches/picomatch@4.0.7.patch";
  assert.equal(config.pnpm?.patchedDependencies?.["picomatch@4.0.7"], patch, "Missing picomatch patch declaration");
  assert.equal(sha256(join(root, patch)), patchHash, "Picomatch patch changed; review the remediation");
  assert.match(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), new RegExp(`hash: ${patchHash}`), "Patch missing from lockfile");
  assert.ok(Array.isArray(tree) && tree.length > 0, "Missing installed dependency graph");
  const paths = new Set();
  const visit = (node) => {
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, child] of Object.entries(node[group] ?? {})) {
        if (name === "picomatch") {
          assert.equal(child.version, "4.0.7", "Unreviewed picomatch version");
          const path = realpathSync(child.path);
          const expected = realpathSync(join(root, `node_modules/.pnpm/picomatch@4.0.7_patch_hash=${patchHash}/node_modules/picomatch`));
          assert.equal(path, expected, "Unpatched picomatch dependency resolution");
          const entry = createRequire(join(node.path, "package.json")).resolve("picomatch");
          assert.equal(
            realpathSync(entry),
            realpathSync(join(expected, "index.js")),
            "Consumer resolves an unpatched picomatch entrypoint",
          );
          paths.add(path);
        }
        visit(child);
      }
    }
  };
  for (const node of tree) visit(node);
  assert.ok(paths.size > 0, "No installed picomatch instances verified");
  for (const path of paths) {
    assert.equal(sha256(join(path, "lib/parse.js")), sourceHash, "Installed picomatch source does not match the reviewed patch");
    const result = spawnSync(process.execPath, [script, "--probe", path], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, `Picomatch security/compatibility probe failed: ${result.error?.message ?? result.stderr}`);
  }
}

export function assessAudit(report, verified, minimum = "low") {
  const levels = ["low", "moderate", "high", "critical"];
  assert.ok(levels.includes(minimum), "Invalid audit threshold");
  assert.ok(
    report && typeof report.advisories === "object" && report.advisories !== null && !Array.isArray(report.advisories),
    "Invalid audit response",
  );
  assert.ok(
    report.metadata?.vulnerabilities &&
      levels.every((level) => Number.isInteger(report.metadata.vulnerabilities[level]) && report.metadata.vulnerabilities[level] >= 0),
    "Missing or invalid audit vulnerability counts",
  );
  const findings = Object.values(report.advisories);
  assert.ok(
    findings.length > 0 || Object.values(report.metadata.vulnerabilities).every((count) => count === 0),
    "Audit response omitted findings",
  );
  const remediated = [];
  const blocking = [];
  for (const item of findings) {
    assert.ok(levels.includes(item.severity), "Unknown advisory severity");
    const fixed =
      verified &&
      item.github_advisory_id === advisory &&
      item.module_name === "picomatch" &&
      item.findings?.length > 0 &&
      item.findings.every((finding) => finding.version === "4.0.7");
    if (fixed) remediated.push(item);
    else if (levels.indexOf(item.severity) >= levels.indexOf(minimum)) blocking.push(item);
  }
  return { remediated, blocking };
}

function runPnpm(args) {
  const env = Object.fromEntries(
    ["HOME", "PATH", "TMPDIR", "SystemRoot"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
  env.npm_config_fetch_timeout = "15000";
  const result = spawnSync("pnpm", args, { env, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error(`pnpm ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  try {
    return { data: JSON.parse(result.stdout), status: result.status };
  } catch {
    throw new Error(`Invalid pnpm ${args[0]} response: ${result.stdout}\n${result.stderr}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    if (process.argv[2] === "--probe") {
      probePicomatch(process.argv[3]);
    } else {
      const audit = runPnpm(["audit", "--json"]);
      // Print the registry report before applying the documented local remediation.
      console.log(JSON.stringify(audit.data, null, 2));
      assert.ok(
        audit.status === 0 || Object.keys(audit.data.advisories ?? {}).length > 0,
        "Audit command failed without a vulnerability report",
      );
      const graph = runPnpm(["list", "picomatch", "--depth", "Infinity", "--json"]);
      assert.equal(graph.status, 0, "Unable to resolve installed dependencies");
      verifyPicomatch(process.cwd(), graph.data);
      const result = assessAudit(audit.data, true, process.argv.includes("--high") ? "high" : "low");
      if (result.remediated.length)
        console.log(
          `${advisory}: locally patched; installed source, provenance and bounded regression probes verified (registry still reports upstream 4.0.7).`,
        );
      console.log(`Dependency audit: ${result.blocking.length} unremediated finding(s) at the required threshold.`);
      process.exitCode = result.blocking.length ? 1 : 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(process.env.HOME ? message.replaceAll(process.env.HOME, "~") : message);
    process.exitCode = 1;
  }
}
