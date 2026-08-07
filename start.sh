#!/bin/bash
set -euo pipefail

# Dev convenience wrapper. For the managed service use: npm run service:install
cd "$(dirname "$0")"
npm start
