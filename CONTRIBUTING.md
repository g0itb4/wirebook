# Working in this repo

wirebook turns proto files into a static site that documents an API and can
call it: over Connect, or over REST when the protos carry `google.api.http`
rules. The part that knows protobuf is Rust, compiled to WebAssembly, so the
browser encodes and decodes with the same code the tests ran natively.

## Commands

Everything goes through `just` from the repo root. `just` alone lists recipes.

```sh
just setup        # tools, dependencies, generated code, the built site, the hooks (once per clone)
just check        # every hook of both stages on every file, as CI does
just fmt          # rewrite formatting in place
just lint         # every linter
just cover        # the three unit tiers, each with its coverage gate
just e2e          # the built site in headless Chromium, against the fixture API
just bench        # the speed of the core, against its budgets
just snippets     # the request as code, read by each language's parser
just audit        # known vulnerabilities in the dependencies (needs the network)
just dist         # rebuild the site that the Go binary embeds
just gen          # regenerate the fixture image, the Go stubs and the golden cases
just build        # bin/wirebook
```

Do not call `cargo`, `go test`, `golangci-lint`, `buf` or `prettier` with
hand-picked flags in a hook or in CI. Add or change a `just` recipe, so the
hooks, CI and a developer's terminal run the same command.

## Layout

| Path | What | Language |
|---|---|---|
| `crates/core` | Everything that can be wrong: schema, documentation model, rules, codec, requests, authentication, variables, responses, streams, the lists ids are picked from, the request as code, search. No I/O, no `unsafe` | Rust |
| `crates/core-wasm` | The core's functions, exported to JavaScript. Decides nothing | Rust |
| `web/src/lib` | The page's logic: routing, environments, secrets, history, `fetch`, the body as a value (`form.ts`), what lists returned (`lookup.ts`) | TypeScript |
| `web/src/ui` | The page's DOM: shell, pages, console, form, picker, dialog | TypeScript |
| `internal/config`, `internal/image`, `internal/site` | A site from bytes: the config, the descriptor set and its roots, the embedded build | Go |
| `internal/bufcli` | Runs buf | Go |
| `internal/serve` | Development server: rebuild, reload, proxy | Go |
| `internal/cli`, `internal/plugin` | The command and the buf plugin: flags in, the packages above wired together | Go |
| `internal/testserver`, `cmd/testserver` | The fixture API of the browser tests. Never imported by what ships | Go |
| `internal/site/dist` | The built site. Committed; see below | built |
| `testdata/proto` | Fixture protos: edition 2024, edition 2023, proto3, proto2 | proto |
| `examples/eliza` | The example site: ConnectRPC's Eliza protos and their `wirebook.json`. `just example` builds it | proto, JSON |

### Where a decision lives

A request is built whole in `crates/core/src/request.rs`: verb, URL, headers,
body, and the credential. The page hands it to `fetch` and adds nothing. The
curl command and the snippets are made from the same value, and a pick of
ids is sent through the same function. This is what makes "what is shown
is what is sent" true, and what lets one native test cover every transport.
Do not add a header in TypeScript.

The same goes for reading a response. `web/src/lib/send.ts` moves bytes and
measures time; `crates/core/src/response.rs` and `frames.rs` say what they
mean.

And for what the schema says about a field: its rules in words, its
example, the list its value is picked from. `crates/core/src/rules.rs` and
`reference.rs` decide; the index carries the result; the page draws it. The
form (`web/src/ui/form.ts`) is a view of the JSON body, which stays the one
thing the core validates and sends.

### Go layering

The dependency arrow points from the commands inwards:

```
cmd  →  cli, plugin  →  serve, site, bufcli  →  image, config
```

`config`, `image` and `site` do no network and run no process. `serve` is
handed a build function and serves what it returns. Nothing that ships
imports `internal/testserver` or Connect. These rules are lint: `depguard` in
`.golangci.yml` fails the pre-commit hook when a forbidden import appears.
When you add a package, add its rule and its coverage floor in the same
commit.

## What is committed though it is built

`internal/site/dist/` holds `core.wasm`, `app.js`, `app.css`, `index.html`
and `fonts/`: the two typefaces, copied from the packages `bun.lock` pins,
with their licence.
It is committed because `go install` and `go tool` compile what is in the
module and run no recipe: the site has to be there. `just dist-check`
(pre-push, and CI) rebuilds it and fails on a difference, or on a file git
does not know, so it cannot go stale. After a change under `crates/` or `web/`, run `just dist` and commit
the result with the change.

The build is held to a size budget in `scripts/size-budget.ts`. A budget
only goes down; each time one went up (the security checks; the form, the
pickers and the code), the file says for what. Before a budget goes up,
measure what grew (`twiggy diff` on an unstripped build of the core) and
take out what is not needed: the float printer and a base64 decoder went
that way.

`testdata/fixture.binpb` and `testdata/golden/cases.json` are generated by
`just gen` and committed, for the same reason: the Rust tests read them, and
a fresh clone has no buf yet.

## Test tiers

| Tier | Recipe | Runs | Gate |
|---|---|---|---|
| Rust core | `just cover-rust` | Native tests, including the golden comparison with protobuf-go | Every line of `crates/core/src` (`crates/coverage.json`) |
| Go | `just cover-go` | Unit tests with the race detector | Per package (`coverage.json`) |
| Web logic | `just cover-web` | `web/src/lib` in bun, against the real core | `bunfig.toml` |
| Browser | `just e2e` | The built site in Chromium, calling the fixture API | Every test passes; axe finds nothing |
| Speed | `just bench` | The core in bun | `scripts/bench.ts` |
| Snippets | `just snippets` | The request as code, with awkward inputs, in sh, node, python3 and go vet | Every snippet parses |

A floor only goes up. When a test tier cannot reach a line, the line is
probably in the wrong place: move the decision into the core, or delete the
branch. Do not lower the floor.

### The golden cases

The codec's reference is protobuf-go. `testdata/golden/cases.in.json` lists
messages as proto JSON; `cmd/golden` writes what protobuf-go makes of each
(wire bytes and JSON) to `cases.json`; `crates/core/tests/golden.rs` holds
the core to it, byte for byte on the wire. A new field shape, a new edition
feature or a codec bug starts with a new case.

### The browser tier

`web/e2e` runs against three processes that Playwright starts: the fixture
API without CORS, the same API allowing the site's origin, and `wirebook
serve` proxying to the first. The API accepts the constants in
`internal/testserver/testserver.go`, and tells the tests which credential it
last saw (`GET /_seen`), because a page cannot show that itself. That count
is also how a test knows a picker called the API once, and only after the
click.

A body opens as a form. A test that types JSON uses `typeBody` from
`web/e2e/helpers.ts`, which switches the view first.

`web/e2e/a11y.spec.ts` scans every kind of page with axe against WCAG 2.2 AA,
at the three widths the layout changes at (1440, 1000 and 390 px). A new
page or state gets a line there.

## Security

The console handles other people's credentials. `SECURITY.md` is the list of
what is defended and how; read it before you touch a request, a credential,
the import, the proxy or anything that writes a file. The rules that a
change is most likely to meet:

- **The URL is built in the core, and checked there.** Anything joined to
  the base URL (a REST template, a name from the schema, a value someone
  typed) is checked to keep the request under the base URL.
  `crates/core/tests/security.rs` has a hostile case for each; a new way to
  build a URL gets one.
- **A secret is bound to its destination** (`destination` in
  `web/src/lib/environments.ts`). A new field of an environment that changes
  where or how a credential is sent goes into it.
- **What comes from outside is rebuilt, not trusted**: a stored row, an
  imported file (`sanitizeEnvironment`, `sanitizeEntry`). A new field is
  added there, with its check, or it does not arrive.
- **A secret is never** in the history, an export, a log, the page's markup
  or a URL that is shown. `web/src/lib/history.test.ts`, the storage dump in
  `web/e2e/console.spec.ts`, `internal/serve/serve_test.go`.
- **Text is text.** No `innerHTML`; the page's Content-Security-Policy would
  refuse an inline script anyway, and `web/e2e/hardening.spec.ts` checks
  that it does, for each kind of build.
- **The curl command is one command.** Every part is single-quoted in
  `crates/core/src/curl.rs`; nothing is added to it outside. A snippet in
  another language writes each value as one string literal, in
  `crates/core/src/snippet.rs`; a new language gets its hostile strings in
  `crates/core/tests/security.rs` and its parser in
  `scripts/snippet-check.ts`.
- **A pick of ids is sent on a click**, to a method declared free of side
  effects, through the same `request` of the core and the same `send` as
  the Send button. Its result is never stored.
- **A variable fills a text value or a header value**, nothing that decides
  where a request goes, and is part of the secret's destination.
- **The proxy serves this site's page only**, and the server answers to
  names it knows. `internal/serve/serve_test.go`.
- **`wirebook.json` cannot hold a secret**: no such field, unknown fields
  are errors, URLs carry no credential. `internal/config/config_test.go`.
- **Dependencies are audited** by `just audit`, in CI on every push and
  weekly. CI pins actions to commits and tools to checksums; when you bump a
  version in `.github/workflows/ci.yml`, bump its SHA-256 with it.

A change that touches any of these changes its test in the same commit.

## The page

- No framework and no runtime dependency. `web/src/ui/dom.ts` is the whole
  toolkit.
- Text from a proto file reaches the page as a text node. Never as markup.
- A page's address is the name of what it shows (`#/package.Message`), so a
  link survives a rebuild.
- Every control has a label, every state a text (not only a colour), and a
  new page takes the focus. Tables that scroll sideways are focusable.
- A target is 24 px high or has that much room.
- Room before rules: space comes from the scale on `:root` in
  `web/src/app.css` (`--s1` to `--s6`), and a console's parts are sections
  (`.card`), not lines and capitals.
- One palette, dark, set once in `web/src/app.css`. Colour is signal: cyan
  reads, magenta writes, amber is a stream or a warning, green is ok, red is
  an error; each with its word. No colour for decoration. Corners take
  `--radius` or `--radius-sm`; no shadow but the focus ring and the marks of
  a selected item. Every pair of text and ground is held to AA by
  `web/src/lib/contrast.test.ts`.
- In a block of code, lightness tells a key or a keyword (`--strong`), a
  value (`--text`) and punctuation or a comment (`--muted`) apart
  (`web/src/lib/highlight.ts`). The signal colours are not used for it.
- Monospace for names, types, values and code; the sans for headings and
  prose. Both fonts are files of the site.
- One effect: an error status arrives with a 240 ms jolt, once, and not at
  all under `prefers-reduced-motion`. Do not add a second.
- A shortcut of one key can be turned off (the environment dialog). A chord
  (⌘K, Ctrl K) is always on: speech input cannot set one off.

## Style

- Comments say why, in full sentences. The code says what.
- Error messages are sentences for the person at the console: what is wrong,
  with the name of the thing.
- Rust: `cargo fmt`, clippy with warnings as errors, no `unsafe`.
- Go: gofumpt and goimports; a `//nolint` names the linter and the reason.
- Commits: imperative subject, no trailer that names a tool.
