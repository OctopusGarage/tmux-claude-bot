#!/usr/bin/env bash
set -euo pipefail

required_major=22

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js %s+ is required; node was not found on PATH.\n' "$required_major" >&2
  exit 1
fi

node_version="$(node --version 2>/dev/null || true)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"

if [[ ! "$node_major" =~ ^[0-9]+$ ]] || ((node_major < required_major)); then
  printf 'Node.js %s+ is required; detected %s.\n' "$required_major" "${node_version:-unknown}" >&2
  exit 1
fi

printf 'Node.js preflight ok: %s (required: %s+)\n' "$node_version" "$required_major"
