// The code the page offers must at least be code: each snippet is given to
// its own language's parser. The requests are the awkward ones: quotes,
// backslashes, dollars and newlines in a body and a header, bytes that are
// not text, a credential in a header and in the query, hidden and shown.
//
//   just snippets
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Core } from "../web/src/lib/core";
import type { Auth, Language, RequestSpec, Transport } from "../web/src/lib/types";

const core = await Core.load(
  readFileSync("internal/site/dist/core.wasm"),
  new Uint8Array(readFileSync("testdata/fixture.binpb")),
  { roots: [], lookups: {} },
);

const HOSTILE = "it's \"quoted\" \\ $HOME `id` ${x} \n two lines \u2028 </script> '''";

const AUTHS: Auth[] = [
  { scheme: "none" },
  { scheme: "bearer", token: "t0ken" },
  { scheme: "basic", username: "ada", password: "love'lace\"$" },
  { scheme: "api-key", name: "X-API-Key", value: "k'e\"y", location: "header" },
  { scheme: "api-key", name: "key", value: "k e&y", location: "query" },
];
const TRANSPORTS: Transport[] = ["connect-json", "connect-proto", "connect-get", "rest"];

/** How each language checks a file, and the file's name. */
const CHECKS: Record<Language, { file: string; command: (path: string) => string[] }> = {
  // -n: read the commands, run none of them.
  curl: { file: "request.sh", command: (path) => ["sh", "-n", path] },
  fetch: { file: "request.mjs", command: (path) => ["node", "--check", path] },
  python: { file: "request.py", command: (path) => ["python3", "-m", "py_compile", path] },
  // vet reads the file as the compiler does: an import that is not used fails.
  go: { file: "request.go", command: (path) => ["go", "vet", path] },
};

const dir = mkdtempSync(join(tmpdir(), "wirebook-snippets-"));
const failures: string[] = [];
let checked = 0;

for (const auth of AUTHS) {
  for (const transport of TRANSPORTS) {
    for (const redact of [true, false]) {
      const spec: RequestSpec = {
        method: "fixture.v1.WidgetService/GetWidget",
        body: JSON.stringify({ id: HOSTILE }),
        transport,
        binding: 0,
        baseUrl: "https://api.example.com/v1's",
        headers: [{ name: "X-Note", value: HOSTILE.replace(/[\n\u2028]/g, " ") }],
        variables: {},
        auth,
        timeoutMs: 1500,
      };
      for (const [language, check] of Object.entries(CHECKS) as [Language, (typeof CHECKS)[Language]][]) {
        const what = `${language}, ${transport}, ${auth.scheme}${redact ? "" : ", with the credential"}`;
        let text: string;
        try {
          text = core.snippet(spec, language, redact);
        } catch (error) {
          failures.push(`${what}: no snippet: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const path = join(dir, check.file);
        writeFileSync(path, `${text}\n`);
        const [command, ...args] = check.command(path);
        const run = spawnSync(command!, args, { encoding: "utf8", cwd: dir });
        checked++;
        if (run.status !== 0) {
          failures.push(`${what}: ${command} refused it:\n${run.stderr || run.stdout || run.error}\n${text}`);
        }
      }
    }
  }
}

console.log(`${checked} snippets parsed, ${failures.length} refused`);
if (failures.length > 0) {
  console.error(failures.slice(0, 5).join("\n\n"));
  process.exit(1);
}
