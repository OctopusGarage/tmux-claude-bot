#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

biome_output="$(node_modules/.bin/biome --version)"
biome_version="${biome_output##* }"
schema_version="$({
  node -e '
    const { readFileSync } = require("node:fs");
    const schema = JSON.parse(readFileSync("biome.json", "utf8")).$schema;
    const match = typeof schema === "string" ? schema.match(/\/schemas\/([^/]+)\//) : null;
    if (match === null) process.exit(2);
    process.stdout.write(match[1]);
  '
})"

if [[ "$schema_version" != "$biome_version" ]]; then
  printf 'Biome schema version mismatch: CLI=%s schema=%s.\n' "$biome_version" "$schema_version" >&2
  exit 1
fi

printf 'Biome schema version ok: %s\n' "$biome_version"
