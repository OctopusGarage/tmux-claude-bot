import { writeConfigEnvironment } from "../../src/core/config/env-store.js";

const [key, value] = process.argv.slice(2);
if (key === undefined || value === undefined) throw new Error("expected key and value");

console.log("STARTING");
writeConfigEnvironment({ [key]: value });
console.log("WROTE");
