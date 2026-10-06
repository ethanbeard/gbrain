#!/usr/bin/env bash
# scripts/ci-dependency-audit.sh — run `bun audit` for the root and admin/
# lockfiles; fail only when the run is blocking (test.yml dependency-audit
# scope step; env BLOCKING=true|false, REASON). Otherwise a found advisory is
# a ::warning:: naming why this run does not block (GBRA-47 B11).
set -uo pipefail

found=0
bun audit || found=1
(cd admin && bun audit) || found=1
if [ "$found" -eq 0 ]; then
  echo "bun audit: no advisories."
  exit 0
fi
if [ "${BLOCKING:-true}" != false ]; then
  echo "::error::bun audit found advisories (blocking: ${REASON:-unknown scope}). Why: this run changes dependencies or protects master, so a known-vulnerable package must not land. Fix: bump the package (bun update <pkg>) or add an overrides entry, then push."
  exit 1
fi
echo "::warning::bun audit found advisories; advisory-only on this pull request (${REASON:-}). Why: an upstream advisory must not turn every open PR red; pushes and the nightly run block on it. Fix: none needed here; to block on it, add the dependency-audit label and push."
exit 0
