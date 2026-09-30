#!/usr/bin/env bash
# Scan the commits that a push would publish. prek sets PRE_COMMIT_FROM_REF and
# PRE_COMMIT_TO_REF in the pre-push stage; outside a push (or for a new branch,
# where the remote ref is all zeros) scan the whole history.
set -euo pipefail

from="${PRE_COMMIT_FROM_REF:-}"
to="${PRE_COMMIT_TO_REF:-HEAD}"

if [[ -n "$from" && ! "$from" =~ ^0+$ ]]; then
  exec gitleaks git --no-banner --redact --log-opts="$from..$to"
fi
exec gitleaks git --no-banner --redact
