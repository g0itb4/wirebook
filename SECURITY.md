# Security

wirebook's console handles other people's credentials and sends requests
with them. This file says what it defends, against whom, how, and what it
does not. Each rule names the test that holds it; `CONTRIBUTING.md` asks
that a change to a rule changes its test in the same commit.

## What is defended

- The credentials typed into the console.
- The APIs reachable from the machine that runs `wirebook serve`.
- The page itself: only its own script runs.
- The machine that runs the command: which files it writes, what it runs.

## Against whom

1. **Another page open in the same browser** while `wirebook serve` runs.
2. **The API**, hostile or compromised, whose answers the page reads.
3. **A proto file, a descriptor set or a `wirebook.json`** contributed to a
   repository by someone who means harm.
4. **An export file** someone is talked into importing.
5. **Whoever sees** an export, a screenshot, a pasted curl command, a log.
6. **The supply chain**: the tools CI downloads and the code it depends on.

## How

### A request goes where it says, and nowhere else

- The base URL is an origin, or one slash and a path. `//host`, `/\host`, a
  user name or password, a query and a backslash are refused: to a browser
  each means something other than it looks like.
  `crates/core/src/url.rs`, `crates/core/tests/security.rs`.
- A REST path comes from the proto file. It must be a path; a template such
  as `.evil.example/x` would otherwise move the request, with the
  credential, to another host. Whatever built it, the final URL is checked
  to be the base URL followed by one slash. `crates/core/src/rest.rs`,
  `crates/core/src/request.rs`.
- A path variable cannot be `.` or `..`: a browser resolves them, escaped or
  not, and the request would go to another path than the one shown.
- A method (the verb of a REST rule) must be an HTTP token that a browser
  sends, and service and method names must be identifiers.
- `fetch` sends no cookie, follows no redirect and sends no referrer.
  `web/src/lib/send.ts`.
- A header that a browser would silently drop is refused by name, so what is
  shown is what is sent. Header values are plain ASCII: no line break can
  add a header.

### A credential stays where it was put

- In memory, unless "Remember in this browser" is ticked; then in the
  browser's store for this site. `web/src/lib/environments.ts`.
- **Bound to its destination.** A secret is used only for the environment as
  it was when the secret was typed: base URL, scheme, key name and place,
  headers, variables. Change any of them outside the dialog (a new build of the site,
  a stored row, an import) and the secret has to be typed again.
- Never in the history, an export, the site's files, or the page's markup.
  The dialog holds no field once it is closed.
- Shown as a variable in the request preview and in the copied code, unless
  "include the credential" is ticked.
- `wirebook.json` has no field for one, an unknown field is an error, and a
  URL in it cannot carry one. `internal/config/config.go`.
- A custom header named like a credential (`Authorization`, `X-Vault-Token`,
  `apikey`, …) is refused: headers are stored and exported as they are. The
  API key scheme sends a key under any header name.
- The console says so when a credential would travel over plain http to
  another machine.

### A pick of ids is a request like any other

A field that names a resource can list real ids from the API. That call
carries the credential, so:

- It is made on a click, never when a page opens. The button names the
  method it calls. `web/e2e/easy.spec.ts` counts the calls the API saw.
- Only a unary method declared `NO_SIDE_EFFECTS` can be the list, by
  convention or by `lookups` in `wirebook.json`; an entry that names another
  kind of method is not used, and the overview says so.
  `crates/core/src/reference.rs`, `crates/core/tests/easy.rs`.
- It goes through the same `request` in the core and the same `send` as the
  Send button: every check on a URL, a header and a credential holds.
  `web/src/lib/lookup.ts`.
- What it returns, and the ids seen in responses, live in the tab's memory,
  per destination of the environment. Not in the browser's store, the
  history or an export. `web/src/lib/lookup.test.ts`, and the storage dump
  in `web/e2e/easy.spec.ts`.

### A variable does not decide where a request goes

`{{name}}` is replaced in the text values of a body and in the values of
custom headers. Not in the base URL, a header's name or the credential.
`crates/core/src/vars.rs`, `crates/core/tests/easy.rs`.

- A value is put into a JSON text as a JSON text: a quote or a brace in it
  cannot add a field. In a header it meets the same check as a typed value:
  no line break. A body field that a REST rule puts into the path is, after
  the replacement, a value like one that was typed: escaped, refused when it
  is `.` or `..`, and held under the base URL.
- Variables are stored and exported as they are, so a name that looks like a
  credential is refused, in the dialog, in a stored row, in an import and in
  `wirebook.json`.
- They are part of the secret's destination: variables that change outside
  the dialog ask for the secret again.
- The history keeps the body as typed, with its placeholders.

### An imported file replaces nothing

An export is JSON from anyone. Every environment in it arrives as a new one,
named "(imported)", never in the place of one the site declares or the
person made. Only the fields an environment has are taken, each checked. It
carries no secret in and has none until one is typed for it.
`web/src/lib/history.ts`, `web/e2e/hardening.spec.ts`.

### The history keeps less than was sent

A field the schema marks `debug_redact` is removed from the body the history
keeps. Keeping bodies can be turned off, and an export leaves them out
unless asked. `crates/core/src/scrub.rs`.

### Only the site's own script runs

- Text from a proto file, a config, an API or an import reaches the page as
  text nodes. There is no `innerHTML`. `web/src/ui/dom.ts`.
- Every build declares a Content-Security-Policy: no inline script, no
  `eval`, nothing loaded from elsewhere. A directory names its files; the
  single file names its script and style by hash. `internal/site/site.go`.
- The fonts are files of the site (`font-src 'self'`), or inside the single
  file (`font-src data:`). No font, style or script comes from another
  origin, so no other server learns who reads the documentation.
- The page refuses to run in a frame of another site, with or without the
  header that forbids it. `web/src/lib/guard.ts`.

### The copied command is one command

Everything in it is in single quotes; a credential's variable is the only
thing left to the shell. A verb, a URL, a header or a body written by someone
else cannot become a second command. `--globoff` keeps curl from reading
braces as a pattern. The quoting is for sh, bash and zsh.
`crates/core/src/curl.rs`.

The same request as `fetch`, Python and Go is built in the core too, never
on the page. Every value from outside is written as one string literal of
its language; a credential is read from the environment
(`process.env.TOKEN`, `os.environ["TOKEN"]`, `os.Getenv("TOKEN")`) unless
asked for. `crates/core/src/snippet.rs`, with the hostile strings in
`crates/core/tests/security.rs`; `just snippets` gives 160 of them to each
language's own parser.

### The development server serves one page

`internal/serve/serve.go`, `internal/serve/serve_test.go`.

- It answers to loopback names. Bound to another address it answers to
  addresses and to the names it was given (`--allow-host`), never to a name
  a stranger could point at it (DNS rebinding).
- The proxy forwards only what the site's own page sends: on loopback, a
  request must carry `Sec-Fetch-Site: same-origin`, which a page cannot set.
  Another site, a typed address and curl are refused.
- A path with a `.` or `..` segment is not forwarded.
- An answer of the API cannot act as a page of this origin: it is sandboxed,
  cannot be framed, and sets no cookie.
- It logs no header and no query string.
- `--target` cannot carry a user name, a password or a query: it is written
  into the site's config.

### The command writes its own files

`wirebook build` never writes through a symbolic link, the directory, a
directory in it (`fonts`) or a file: a repository cannot aim the build at a
file elsewhere. The buf
plugin's output name stays inside the output directory. buf is run without a
shell. `internal/site/site.go`, `internal/plugin/plugin.go`.

### What the page reads cannot take it down

A response or a frame is read up to 32 MB, a stream keeps its last 1,000
frames, and a block of text shows its first 500,000 characters. A test feeds
the core thousands of damaged responses and requires an answer in words to
each. `crates/core/tests/security.rs`.

### What CI runs is what was reviewed

Actions are pinned to a commit and downloaded tools to a SHA-256. The job
token can only read. `just audit` (govulncheck, cargo-audit, bun audit) runs
on every push and weekly. `.github/workflows/ci.yml`.

## What it does not defend

- **A remembered credential from other pages of the same origin.** Sites that
  share an origin (two paths on one host) can read each other's store. Do
  not tick "remember" on a shared host. Pages opened from the disk share one
  store in some browsers, so there the box is disabled.
- **A request body's content.** What is typed into a body is kept in the
  history as typed, except fields marked `debug_redact`. Turn keeping off
  for an API that takes secrets in bodies.
- **A key in the query string** from the logs of the servers on the way.
- **`wirebook serve` on a public address.** Whoever can reach it can read
  the site and use the proxy. It warns, and it is still your choice.
- **The API's own errors.** A hostile API can answer anything; the page
  shows it as text.
- **Other shells.** The curl command is quoted for sh, bash and zsh.
- **A list that is not what it says.** A picker trusts the schema's
  `NO_SIDE_EFFECTS`. A method declared so that changes something is called
  all the same, on the click.
- **What a variable holds.** A variable is stored and exported. A secret
  given a harmless name is kept like any other text.
- **A rule the server enforces differently.** The warnings are a subset of
  protovalidate, without patterns and CEL. They are a help, not a guard.
- **A schema nobody reviewed.** The explorer shows where a request will go
  before it goes; a proto file can still describe an API you did not mean
  to call.

## Reporting

Open an issue for a weakness that puts nobody at risk. For one that does,
write to the maintainer privately first; the address is on the GitHub
profile of the repository's owner.
