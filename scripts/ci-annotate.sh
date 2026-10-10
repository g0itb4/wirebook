#!/usr/bin/env bash
# After a failed step of CI: the tail of its output, the state of the working
# tree, and what differs in a rebuilt core.wasm, each as an annotation of the
# job. The API shows annotations without a token, so a failure can be read
# from outside, where the log cannot.
#
#   scripts/ci-annotate.sh <log>
set -uo pipefail

log="$1"
annotate() {
  # One annotation holds up to 4 KB; newlines and percent signs are encoded.
  local title="$1"
  local text
  text="$(tail -c 3800 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')"
  echo "::error title=${title}::${text}"
}

if [ -s "$log" ]; then
  grep -v 'Passed\|Skipped' "$log" | annotate "the tail of the output"
else
  echo "::error title=no log::the step that failed wrote no $log"
fi
{ git status --short; git diff --stat; } | annotate "the working tree after it"
if ! git diff --quiet -- internal/site/dist/core.wasm; then
  git show HEAD:internal/site/dist/core.wasm > "${TMPDIR:-/tmp}/committed.wasm"
  {
    diff <(strings -n 6 "${TMPDIR:-/tmp}/committed.wasm") <(strings -n 6 internal/site/dist/core.wasm) | head -60
    cmp -l "${TMPDIR:-/tmp}/committed.wasm" internal/site/dist/core.wasm | head -40
  } | annotate "core.wasm, committed versus rebuilt"
fi
