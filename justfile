set shell := ["zsh", "-cu"]

# So a recipe can forward its arguments with "$@" and keep the caller's quoting.
set positional-arguments := true

wasm_target := "target/wasm32-unknown-unknown/release/wirebook_core_wasm.wasm"
dist := "internal/site/dist"

# list recipes
default:
    @just --list

# install dependencies and tools, generate code, build the site and install the git hooks, on a fresh clone
setup:
    bun install --frozen-lockfile
    go mod download
    cargo install --locked cargo-llvm-cov --version 0.9.1
    cargo install --locked cargo-audit --version 0.22.2
    cargo install --locked wasm-bindgen-cli --version "$(just _bindgen-version)"
    command -v wasm-opt >/dev/null || brew install binaryen
    cd web && bunx playwright install chromium
    @just gen
    @just dist
    @just hooks

# install the git hooks (pre-commit and pre-push)
hooks:
    prek install --overwrite

# run every hook of both stages on every file, as CI does
check:
    prek run --all-files
    prek run --all-files --stage pre-push

# ── generate ─────────────────────────────────────────────────────────────────

# regenerate what is derived from the fixture protos: the image, the Go test server's stubs, the golden cases
gen: image
    bunx buf generate
    go run ./cmd/golden

# The descriptor set of testdata/proto, as a Buf image: source info for the
# comments, and the mark that tells a file of the module from an import.
[private]
image:
    bunx buf build -o testdata/fixture.binpb

# ── build ────────────────────────────────────────────────────────────────────

[private]
_bindgen-version:
    @grep -m1 'wasm-bindgen = "=' crates/core-wasm/Cargo.toml | sed 's/.*"=\(.*\)"/\1/'

# The wasm-bindgen CLI must match the crate's version exactly: a skew makes
# glue that does not fit the module, and it fails only in the browser.
#
# wasm-opt gets the features rustc already uses, and no others, so the module
# runs wherever the unoptimised one would.
#
# build the core for the browser: core.wasm and its JavaScript glue
wasm:
    #!/usr/bin/env zsh
    set -eu
    crate=$(just _bindgen-version)
    cli=$(wasm-bindgen --version | awk '{print $2}')
    if [[ "$crate" != "$cli" ]]; then
      echo "wasm-bindgen skew: the crate pins $crate, the CLI is $cli" >&2
      echo "fix: cargo install -f --locked wasm-bindgen-cli --version $crate" >&2
      exit 1
    fi
    # Paths of this machine stay out of the module: a panic message names the
    # file it came from, and the committed build must not depend on where it
    # was built.
    RUSTFLAGS="--remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$PWD=/wirebook" \
      cargo build --locked -p wirebook-core-wasm --target wasm32-unknown-unknown --release
    rm -rf web/src/gen
    wasm-bindgen --target web --out-dir web/src/gen --out-name core {{ wasm_target }}
    wasm-opt -Os --enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int \
      --enable-sign-ext --enable-mutable-globals --enable-multivalue --enable-reference-types \
      web/src/gen/core_bg.wasm -o web/src/gen/core_bg.wasm

# The Go binary embeds this directory, so it is committed: `go install` and
# `go tool` build from source and run no recipe. CI rebuilds it and fails on
# a difference.
#
# build the site's files (page, script, style, core.wasm) into the directory the Go binary embeds
dist: wasm
    #!/usr/bin/env zsh
    set -eu
    rm -rf {{ dist }}
    mkdir -p {{ dist }}
    cd web
    bun build src/main.ts --outfile ../{{ dist }}/app.js --target browser --format esm --minify
    # The fonts stay files beside the style (--external), and the licence
    # notice stays in it: a /*! comment survives --minify.
    bun build src/app.css --outfile ../{{ dist }}/app.css --target browser --minify --external 'fonts/*'
    cp src/index.html ../{{ dist }}/
    cp src/gen/core_bg.wasm ../{{ dist }}/core.wasm
    # The two typefaces of the page, Latin only, from the packages bun.lock pins.
    mkdir -p ../{{ dist }}/fonts
    fonts=../node_modules/@fontsource-variable
    cp $fonts/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2 ../{{ dist }}/fonts/jetbrains-mono.woff2
    cp $fonts/space-grotesk/files/space-grotesk-latin-wght-normal.woff2 ../{{ dist }}/fonts/space-grotesk.woff2
    # Their licence asks that it goes where the fonts go.
    cat $fonts/jetbrains-mono/LICENSE $fonts/space-grotesk/LICENSE > ../{{ dist }}/fonts/OFL.txt
    cd ..
    just size

# the size of the core and of the script against their budgets
size:
    bun scripts/size-budget.ts

# build the wirebook binary into bin/
build: dist
    go build -o bin/wirebook ./cmd/wirebook

# ── example ──────────────────────────────────────────────────────────────────

# ConnectRPC's Eliza, the site wirebook.pigface.lol serves. The fixture under
# testdata stays the test corpus; this is what a visitor sees.
#
# build the Eliza example as a site, into out/eliza
example: build
    rm -rf out/eliza
    bin/wirebook build --dir examples/eliza --out out/eliza --buf "bunx buf"

# serve the Eliza example while editing it, with the proxy to demo.connectrpc.com
example-serve: build
    bin/wirebook serve --dir examples/eliza --buf "bunx buf" --target https://demo.connectrpc.com

# ── tests ────────────────────────────────────────────────────────────────────

# the fixture API and the wirebook binary, for the end-to-end tests
[private]
bins: dist
    go build -o bin/wirebook ./cmd/wirebook
    go build -o bin/testserver ./cmd/testserver

# In headless Chromium, through Playwright: the built site, served by
# `wirebook serve`, calling the fixture API over every transport and with
# every authentication scheme; then an accessibility scan at two widths.
#
# the site end to end, in a browser
e2e *args: bins
    cd web && bunx playwright test "$@"

# every test tier: the hooks, the site in a browser, the speed budgets, and the snippets
test: check e2e bench snippets

# The module is compiled once per page load; what a person waits for after
# that is the schema loading, and each keystroke being validated.
#
# the speed of the core, against its budgets
bench: dist
    @mkdir -p coverage
    go run ./cmd/benchimage
    bun scripts/bench.ts

# The page offers a request as curl, fetch, Python and Go. The core's tests
# hold the escaping; this holds that what comes out is code at all, with the
# awkward inputs, by giving each snippet to sh, node, python3 and go.
#
# the request as code, read by each language's own parser
snippets: dist
    bun scripts/snippet-check.ts

# ── style ────────────────────────────────────────────────────────────────────

# rewrite files in place: rustfmt, gofumpt + goimports, buf format, prettier
fmt:
    cargo fmt --all
    golangci-lint fmt
    bunx buf format -w
    bunx buf format -w examples/eliza
    bunx prettier --write --log-level warn .

# fail on a formatting diff, without rewriting (the pre-commit hooks)
fmt-check: fmt-check-rust fmt-check-go fmt-check-proto fmt-check-web

[private]
fmt-check-rust:
    cargo fmt --all -- --check

[private]
fmt-check-go:
    golangci-lint fmt --diff

[private]
fmt-check-proto:
    bunx buf format --diff --exit-code
    bunx buf format --diff --exit-code examples/eliza

[private]
fmt-check-web:
    bunx prettier --check --log-level warn .

# ── lint ─────────────────────────────────────────────────────────────────────

# every linter
lint: lint-rust lint-go lint-proto typecheck

# clippy, warnings as errors; the wrapper crate against its only target
lint-rust:
    cargo clippy --all-targets -- -D warnings
    cargo clippy -p wirebook-core-wasm --target wasm32-unknown-unknown -- -D warnings

# govet, staticcheck, errcheck, revive, gosec, and depguard for the layering
lint-go:
    golangci-lint run

# buf lint on the fixture and the example protos: naming, packages, and the STANDARD rule set
lint-proto:
    bunx buf lint
    bunx buf lint examples/eliza

# The page imports the glue that wasm-bindgen writes, which is not committed.
[private]
_glue:
    @test -f web/src/gen/core.js || just wasm

# TypeScript in the web app, its tests and the scripts
typecheck: _glue
    cd web && bunx tsc --noEmit

# llm/index.md is loaded into every agent session through CLAUDE.md, so it
# stays inside a size budget, and every path and recipe it names must exist.
#
# check the agent index against the repo
llm-check:
    bun scripts/llm-index-check.ts

# ── dependencies ─────────────────────────────────────────────────────────────

# Needs the network, so it is a recipe and a CI job, not a hook. govulncheck
# reports a vulnerability only when the code can reach it.
#
# known vulnerabilities in the Go modules, the Rust crates and the JavaScript packages
audit:
    go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
    cargo audit
    bun audit

# ── secrets ──────────────────────────────────────────────────────────────────

[private]
secrets-staged:
    gitleaks git --pre-commit --staged --no-banner --redact

[private]
secrets-push:
    scripts/gitleaks-push.sh

# scan the whole history for secrets
secrets:
    gitleaks git --no-banner --redact

# ── coverage ─────────────────────────────────────────────────────────────────

# every coverage gate
cover: cover-rust cover-go cover-web

# The core is pure, so its floor is every line. The profile goes through
# scripts/lcov-gate.ts, which holds each file to the floor of its directory
# in crates/coverage.json.
#
# Rust tests, then the per-file coverage gate
cover-rust:
    @mkdir -p coverage
    cargo llvm-cov -p wirebook-core --lcov --output-path coverage/rust.lcov
    bun scripts/lcov-gate.ts coverage/rust.lcov

# The profile goes through covergate, which holds each package to its floor
# in coverage.json. Generated code is left out of the run.
#
# Go tests with the race detector, then the per-package coverage gate
cover-go:
    #!/usr/bin/env zsh
    set -eu
    mkdir -p coverage
    packages=(${(f)"$(go list ./... | grep -v '/internal/testserver')"})
    go test -race -coverprofile=coverage/unit.coverprofile $packages >coverage/unit.log 2>&1 \
      || { cat coverage/unit.log; exit 1 }
    go run ./cmd/covergate

# The logic of the page (web/src/lib), against the real core, in bun. The
# thresholds are in bunfig.toml and, like the other floors, only go up.
#
# web unit tests, with the coverage thresholds
cover-web: _glue
    bun test

# ── what is committed and derived ────────────────────────────────────────────

# The built site is committed, because `go install` only compiles. This is
# what keeps it from going stale. A file of the build that git does not know
# is a file the commit forgot: `git diff` alone would not say so.
#
# rebuild the embedded site and fail when it differs from what is committed
dist-check: dist
    git diff --exit-code --stat -- internal/site/dist
    @test -z "$(git ls-files --others --exclude-standard -- internal/site/dist)" || { echo "internal/site/dist has files that are not added to git:"; git ls-files --others --exclude-standard -- internal/site/dist; exit 1; }

# regenerate the fixture image and the golden cases and fail when they differ from what is committed
gen-check: gen
    git diff --exit-code --stat -- testdata
