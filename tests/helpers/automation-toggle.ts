import { runAutomationCommand } from "../../src/core/config/command.js";

const target = process.argv[2];
if (target === undefined) throw new Error("expected automation target");

console.log("STARTING");
const result = runAutomationCommand(["pause", target]);
if (result.exitCode !== 0) throw new Error(result.stderr);
console.log("WROTE");
