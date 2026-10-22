#!/bin/bash
set -euo pipefail

# Dev convenience wrapper. For the managed service use: pnpm service:install
cd "$(dirname "$0")"
pnpm start
