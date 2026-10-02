# wirebook: index for agents

Proto files in, a static API explorer out: documentation of every service and message, and a console that calls the API over Connect or REST. The core is Rust, compiled to WebAssembly; the page is TypeScript without a framework; the command and the buf plugin are Go.
Each entry names where a thing starts. Read those files, and the document named with them, before you edit.

## Rules a hook or CI enforces

- Run tools through `just`, never with hand-picked flags. `just check` runs every hook, as CI does.
- Never edit generated or built files: `internal/site/dist/`, `web/src/gen/`, `internal/testserver/gen/`, `testdata/fixture.binpb`, `testdata/golden/cases.json`. Change the source, then run `just dist` or `just gen`, and commit the diff of `internal/site/dist/` and `testdata/`.
- A coverage floor only goes up; a size or speed budget only goes down. `crates/core/src/` stays at every line (`crates/coverage.json`); the Go floors are in `coverage.json`; the web thresholds in `bunfig.toml`.
- Every decision about a request or a response is made in `crates/core/`. `crates/core-wasm/src/lib.rs` and `web/src/lib/core.ts` only pass arguments through.
- The codec must agree with protobuf-go: add a case to `testdata/golden/cases.in.json` and run `just gen`.
- A secret is never stored, logged, exported, put in the page's markup or in a URL that is shown, unless the person asked; and it is used only for the destination it was typed for. Read `SECURITY.md` before touching a request, a credential, the import, the proxy or a file write.
- Every URL is built and checked in `crates/core/`; a new way to build one gets a hostile case in `crates/core/tests/security.rs`.
- The config file has no field that could hold a secret, and an unknown field is an error: `internal/config/config.go`.
- Text reaches the page as text nodes, through `web/src/ui/dom.ts`. No `innerHTML`.
- Go imports point from the commands inwards; depguard in `.golangci.yml` checks them. A new Go package needs a rule there and a floor in `coverage.json`.

The reasons, and the rest of the rules: `CONTRIBUTING.md`.

## Features

- **Schema and comments**: the descriptor set, linked, with the comment of every declaration. `crates/core/src/schema.rs`.
- **Documentation model**: files, services, messages, enums as the page renders them. `crates/core/src/index.rs`, `crates/core/tests/docs.rs`.
- **Codec**: proto JSON to wire bytes and back, validation of a typed body. `crates/core/src/codec.rs`, `crates/core/tests/golden.rs`.
- **Example bodies**: `crates/core/src/template.rs`.
- **Requests**: Connect POST (JSON, binary), Connect GET, server streaming, custom headers. `crates/core/src/request.rs`, `crates/core/tests/request.rs`.
- **REST**: google.api.http bindings, path variables, query, body. `crates/core/src/rest.rs`.
- **Authentication**: none, Bearer, Basic, API key in a header or the query. `crates/core/src/auth.rs`; the settings and the secrets on the page: `web/src/lib/environments.ts`, `web/src/ui/environments.ts`.
- **Responses and streams**: messages, Connect errors with decoded details, REST errors, envelopes. `crates/core/src/response.rs`, `crates/core/src/frames.rs`, `crates/core/tests/response.rs`.
- **curl**: the request as a command, single-quoted, with the secret as a shell variable. `crates/core/src/curl.rs`.
- **Hardening**: hostile inputs to the core in `crates/core/tests/security.rs`; sensitive fields out of the history in `crates/core/src/scrub.rs`; the secret's destination and the checks on stored and imported rows in `web/src/lib/environments.ts`; the frame guard in `web/src/lib/guard.ts`; the browser-side cases in `web/e2e/hardening.spec.ts`.
- **Search**: `crates/core/src/search.rs`.
- **Sending**: `fetch` with no cookie and no redirect, the stream reader, the explanation of a CORS failure. `web/src/lib/send.ts`.
- **History and export**: what the browser keeps, in IndexedDB. `web/src/lib/history.ts`, `web/src/lib/store.ts`.
- **Pages**: shell, navigation and search in `web/src/ui/app.ts`; documentation pages in `web/src/ui/pages.ts`; the method page and console in `web/src/ui/console.ts`; styles in `web/src/app.css`. Verify with `just e2e`.
- **Command**: `build` and `serve`. `internal/cli/cli.go`, `cmd/wirebook/main.go`.
- **buf plugin**: one HTML file. `internal/plugin/plugin.go`, `cmd/protoc-gen-wirebook/main.go`.
- **Site assembly**: the embedded build plus one repository's schema and config. `internal/site/site.go`, `internal/image/image.go`, `internal/config/config.go`.
- **Development server and proxy**: rebuild on change, reload, forward to the API for this site's page only, answer to known host names only. `internal/serve/serve.go`.
- **Fixture API**: Connect and REST behind every scheme, for the browser tests. `internal/testserver/testserver.go`, `testdata/proto/`.
- **Budgets and audits**: `scripts/size-budget.ts` (`just size`), `scripts/bench.ts` (`just bench`), `just audit`. CI pins: `.github/workflows/ci.yml`, `scripts/fetch-tool.sh`.

## Documents

- `CONTRIBUTING.md`: commands, layout, layering, test tiers, the rules for secrets and for the page.
- `README.md`: what it is, quick start, configuration, measured results, limits.
- `SECURITY.md`: what is defended, against whom, how, and what is not.
