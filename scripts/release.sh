#!/bin/bash
# Cut a release: bump version in package.json, tag vX.Y.Z, push.
# GitHub Actions (release.yml) then creates the GitHub Release.
#   pnpm release -- patch        (0.1.0 -> 0.1.1)
#   pnpm release -- minor|major
#   pnpm release -- 1.2.3        (explicit)
set -euo pipefail

BUMP="${1:-}"
if [ -z "$BUMP" ]; then
  echo "usage: pnpm release -- <patch|minor|major|X.Y.Z>" >&2
  exit 1
fi

# Must be on main with a clean tree.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "release must run on main (on '$BRANCH')" >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "working tree not clean" >&2; exit 1; }
git pull --ff-only origin main

if [ -z "${TCB_RELEASE_SKIP_VERIFY:-}" ]; then
  pnpm verify:local
  git diff --quiet && git diff --cached --quiet || {
    echo "local verification changed the working tree; inspect before releasing" >&2
    exit 1
  }
else
  echo "TCB_RELEASE_SKIP_VERIFY set - skipping pnpm verify:local"
fi

# pnpm version bumps package.json + pnpm-lock.yaml, commits, and tags vX.Y.Z.
NEW_TAG="$(pnpm version "$BUMP" -m "release: v%s")"
echo "Created $NEW_TAG"

git push --follow-tags origin main
echo "Pushed $NEW_TAG. GitHub Actions will publish the Release."
