# wirebook

Write proto files; get a site that documents the API and can call it.

wirebook reads the descriptor set of a buf module and writes a static site:
every service, method, message and enum with its comments, and on each method
a console that sends a real request, over Connect or over REST, with the
authentication the API asks for, and shows what came back.

- **Current protobuf.** Edition 2024, edition 2023, proto3 and proto2. Field
  presence, enum openness, delimited and expanded encoding follow each file's
  resolved features.
- **The codec runs in the browser, as WebAssembly.** One prebuilt module of
  Rust reads any descriptor set at run time. Nothing is generated per
  schema, and nothing recompiles when a proto changes.
- **The same bytes as a Go server.** The codec is tested against protobuf-go,
  byte for byte on the wire.
- **No server and no database.** The site is static files, or one HTML file.
  What a visitor keeps (environments, history) stays in their browser.

## Quick start

### While writing protos

In the directory of a buf module (the one with `buf.yaml`):

```sh
wirebook serve --target http://localhost:8080
```

It builds the site, serves it on <http://127.0.0.1:9000>, rebuilds and
reloads the page when a proto changes, and forwards `/proxy` to the API. The
proxy is there because a browser may only read an answer from another origin
when that origin allows it (CORS); through the proxy the page talks to its
own origin. buf is run as `buf`; pass `--buf "bunx buf"` when that is how
the repository runs it.

### As a site to host

```sh
wirebook build --out site            # a directory of static files
wirebook build --single-file api.html   # or everything in one file
```

Serve the directory with anything. The single file opens from a disk. A
hosted site calls the API directly, so the API must allow the site's origin:
see [CORS](#cors).

### As a buf plugin

```yaml
# buf.gen.yaml
plugins:
  - local: ["go", "tool", "protoc-gen-wirebook"]
    out: docs/explorer
    strategy: all
```

```sh
go get -tool github.com/g0itb4/wirebook/cmd/protoc-gen-wirebook
buf generate          # writes docs/explorer/index.html
```

The plugin's version is pinned in `go.mod`, like the other plugins of the
module. Its options (`opt:`) are `config=path`, `out=name.html` and
`title=text`.

## Configuration

Optional. `wirebook.json`, next to `buf.yaml`:

```json
{
  "title": "Widgets API",
  "environments": [
    { "name": "local", "baseUrl": "http://localhost:8080" },
    { "name": "staging", "baseUrl": "https://staging.example.com" }
  ],
  "auth": [{ "scheme": "bearer" }, { "scheme": "api-key", "name": "X-API-Key", "location": "header" }]
}
```

`auth` lists the schemes the API accepts; the console offers those. Without
it, all four are offered. The file is committed and the site may be public,
so it has no field for a credential, and an unknown field is an error.

## The console

On each method:

| Send as | When | What goes out |
|---|---|---|
| Connect, JSON | always | `POST /package.Service/Method`, `Content-Type: application/json`, `Connect-Protocol-Version: 1` |
| Connect, binary | always | the same, `application/proto`, the wire format |
| Connect, GET | the method is declared `NO_SIDE_EFFECTS` | `GET …?connect=v1&encoding=json&message=…` |
| REST | the method has a `google.api.http` rule | the rule's verb and path; fields split between path, query and body |

A server-streaming method is sent over Connect and its messages are shown as
they arrive. A method that takes a stream of requests is documented, but
cannot be called: a browser cannot send one.

The body is checked against the schema as it is typed, with the line and
column of what is wrong. "What will be sent" shows the request before it
goes. "Copy as curl" gives the same request as a command.

### Authentication

| Scheme | Sent as |
|---|---|
| None | nothing |
| Bearer | `Authorization: Bearer <token>` |
| Basic | `Authorization: Basic base64(user:password)` (RFC 7617) |
| API key | a header of your naming (default `X-API-Key`), or a query parameter |

An OAuth2 or OIDC access token is a Bearer token: get it as you usually do,
and paste it. The login flows themselves, mutual TLS, AWS SigV4 and cookie
sessions are not supported.

A scheme is set per environment and applies to every transport.

### What happens to a credential

- It is kept in the tab's memory. It is stored in the browser only when
  "Remember in this browser" is ticked, and removed when it is unticked.
- It is used only for the environment it was typed for. When the base URL,
  the scheme or the headers change by anything but your own edit (a new
  build, an imported file), it has to be typed again.
- It is never written to the history, to an export, to the page's markup or
  to the site's files.
- The request preview and the copied curl command show a shell variable
  (`$TOKEN`, `$BASIC_CREDENTIALS`, `$API_KEY`) in its place, unless "include
  the credential" is ticked.
- Requests carry no cookie and follow no redirect, and the URL is checked to
  lie under the base URL you chose, whatever the proto file says.
- `wirebook serve` answers to `localhost` names only, its proxy serves only
  its own page, and it logs no header and no query string.

The history keeps request bodies, without the fields the schema marks
`debug_redact`. The environment dialog turns that off. An export leaves
bodies out unless asked, and an imported file never replaces an environment:
what it brings arrives as new ones, marked as imported.

`SECURITY.md` has the whole of it: what is defended, against whom, and what
is not.

### CORS

A site on one origin calling an API on another needs the API to allow it.
The API must answer the preflight (`OPTIONS`) with the site's origin in
`Access-Control-Allow-Origin` and allow these request headers:
`Content-Type`, `Connect-Protocol-Version`, `Connect-Timeout-Ms`,
`Authorization`, and the header of your API key if you use one. When a call
fails for this reason the console says so, and says what to check.

## Does it need a database?

No. The schema is one static file. Environments, the history of calls and a
remembered credential live in the visitor's browser (IndexedDB), and can be
exported and imported as JSON, without credentials. To share requests with a
team, commit them as files.

## Measured

On the development machine (Apple silicon), 2 October 2026. `just size`,
`just bench`, `just cover` and `just e2e` reproduce them.

| What | Result |
|---|---|
| Site, gzipped: core.wasm + app.js + app.css + index.html | 256 kB (236 + 16 + 3 + 0.5) |
| Compile the core and load a 152 kB schema | 25 ms |
| Load and index a schema of 2,000 messages (2.3 MB) | 68 ms |
| Search that schema | 5 ms |
| Validate a body, or build a request | 0.01 ms |
| Codec against protobuf-go | 15 cases, identical wire bytes and JSON |
| Line coverage, Rust core | 100% |
| Statement coverage, Go | 100%, except `internal/cli` at 99% |
| Line coverage, page logic (`web/src/lib`) | 100% |
| Browser tests | 41: every transport with every scheme, CORS, streams, storage, and what a hostile page, file or frame cannot do |
| Damaged responses fed to the core | 4,000, each answered in words |
| Known vulnerabilities in dependencies (`just audit`) | none: Go, 35 Rust crates, JavaScript |
| Accessibility scan (axe, WCAG 2.2 AA) | no violation: desktop, phone, dark |

The times are in bun's JavaScript engine, not in a browser.

## Limits

- **buf is required** to compile the protos (1.68 or later for edition
  2024). wirebook does not parse proto files.
- **Edition 2024 is the newest edition supported.**
- **Client and bidirectional streaming cannot be sent** from a browser.
- **gRPC and gRPC-Web are not spoken**, only Connect and REST.
- **protovalidate rules are not shown or checked.** The body is checked for
  shape, not for the constraints in `buf.validate` options.
- **REST needs the API to transcode** (Vanguard, grpc-gateway, Envoy).
  wirebook builds the request the rule describes; it does not transcode.
- **The protobuf library, buffa, is before 1.0.** The golden tests are what
  hold it to protobuf-go's behaviour here.
- **The body is typed as JSON.** There is no generated form.

## How it is built

```
.proto ── buf ──> descriptor set ──> wirebook (Go) ──> index.html app.js app.css
                                                       core.wasm schema.binpb config.json

page (TypeScript) ──> core.wasm (Rust): documentation, search, validation,
                                        the request, the reading of the response
page ──> fetch ──> the API, or `wirebook serve`'s proxy to it
```

`CONTRIBUTING.md` has the layout, the rules and the test tiers; `SECURITY.md`
what is defended and how.

## Licence

MIT. See `LICENSE`.
