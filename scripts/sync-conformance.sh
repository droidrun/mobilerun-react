#!/usr/bin/env bash
# Copyright 2026 Mobilerun
# SPDX-License-Identifier: Apache-2.0
# Refresh the vendored conformance fixtures.
#
# Usage: scripts/sync-conformance.sh TAG [CLONE_DIR]
#
# Without CLONE_DIR the public repository is cloned into a temporary directory.
# The copy lives in conformance/fixtures and the tag is recorded in
# conformance/VERSION. Always pass a release tag, never a branch.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 TAG [CLONE_DIR]" >&2
  exit 2
fi

tag="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

clone="${2:-}"
if [ -z "$clone" ]; then
  clone="$tmp/clone"
  git clone --quiet https://github.com/droidrun/mobilerun-sdk-conformance "$clone"
else
  git -C "$clone" fetch --tags --quiet
fi

git -C "$clone" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null || {
  echo "unknown tag: $tag" >&2
  exit 1
}

mkdir "$tmp/out"
git -C "$clone" archive "$tag" fixtures | tar -x -C "$tmp/out"

rm -rf "$root/conformance/fixtures"
mkdir -p "$root/conformance"
mv "$tmp/out/fixtures" "$root/conformance/fixtures"
printf '%s\n' "$tag" > "$root/conformance/VERSION"
echo "conformance fixtures now at $tag"
