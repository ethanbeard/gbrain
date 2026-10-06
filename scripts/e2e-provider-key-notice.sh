#!/usr/bin/env bash
# scripts/e2e-provider-key-notice.sh — make keyless E2E coverage visible (GBRA-47 A9).
#
# e2e.yml passes the OPENAI_API_KEY / ANTHROPIC_API_KEY repo secrets to its
# key-gated jobs; when a secret is empty, the key-gated tests self-skip and
# the job still goes green. This step says so in the log (::warning::) and the
# step summary, with the owner-only fix, so a green run is never read as
# keyed coverage. Exit 0 always: it reports, it does not gate.
set -euo pipefail

missing=()
[ -n "${OPENAI_API_KEY:-}" ] || missing+=(OPENAI_API_KEY)
[ -n "${ANTHROPIC_API_KEY:-}" ] || missing+=(ANTHROPIC_API_KEY)

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
if [ "${#missing[@]}" -eq 0 ]; then
  echo "Provider secrets set (OPENAI_API_KEY, ANTHROPIC_API_KEY): key-gated E2E tests ran keyed."
  exit 0
fi

fix=$(printf 'gh secret set %s; ' "${missing[@]}")
echo "::warning::Key-gated E2E tests skipped for missing keys: empty secret(s) ${missing[*]}. Why: only the repo owner can set secrets. Fix (owner-only): ${fix%; }"
{
  echo "## Key-gated E2E tests skipped for missing keys"
  echo "Empty secret(s): ${missing[*]}. Tests gated on these keys self-skipped, so this job's green is keyless coverage only."
  echo ""
  echo "- Fix (owner-only): \`${fix%; }\`"
} >> "$summary"
