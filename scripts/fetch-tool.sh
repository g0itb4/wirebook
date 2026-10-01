#!/usr/bin/env bash
# Download a release archive, check it against a SHA-256 written in the
# workflow, and install one binary from it. CI runs what it downloads with
# the repository checked out, and what it builds is committed and shipped:
# a tool that is not the one that was reviewed must not run.
#
#   scripts/fetch-tool.sh <url> <sha256> <path-in-archive> <install-dir>
set -euo pipefail

url="$1"
sha256="$2"
member="$3"
dir="$4"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -sSfL --proto '=https' --tlsv1.2 -o "$work/archive.tar.gz" "$url"
echo "$sha256  $work/archive.tar.gz" | sha256sum --check --quiet
tar -xzf "$work/archive.tar.gz" -C "$work" "$member"
mkdir -p "$dir"
install -m 0755 "$work/$member" "$dir/$(basename "$member")"
echo "installed $(basename "$member") from $url"
