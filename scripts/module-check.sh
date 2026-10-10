#!/usr/bin/env bash
# The module job of CI, on a macOS runner: the two tools that build the
# module, checked against their SHA-256, then the rebuild of the embedded
# site and its comparison with what is committed. One script, so that one
# log holds every step and a failure can be annotated whole.
set -euo pipefail

bin="$HOME/.local/bin"
scripts/fetch-tool.sh \
  "https://github.com/rustwasm/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/wasm-bindgen-${WASM_BINDGEN_VERSION}-aarch64-apple-darwin.tar.gz" \
  "$WASM_BINDGEN_SHA256_MACOS" \
  "wasm-bindgen-${WASM_BINDGEN_VERSION}-aarch64-apple-darwin/wasm-bindgen" \
  "$bin"
scripts/fetch-tool.sh \
  "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-arm64-macos.tar.gz" \
  "$BINARYEN_SHA256_MACOS" \
  "binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt" \
  "$bin"
export PATH="$bin:$PATH"
wasm-bindgen --version
wasm-opt --version
rustc --version
bun --version
bun install --frozen-lockfile
just dist-check
