#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
rm -rf dist
npm run build
