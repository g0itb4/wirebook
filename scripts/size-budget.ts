// The site has to load fast on a cold cache, so what it ships is held to a
// budget, gzipped, as a server sends it. A budget only goes down: when the
// build gets smaller, lower the number.
//
//   bun scripts/size-budget.ts
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const DIST = "internal/site/dist";

// Bytes, gzipped at level 9.
const BUDGET: Record<string, number> = {
  // Raised once, from 240 000, for what makes a request easy: the schema's
  // rules and examples, the lists a field's value is picked from, the
  // variables, and the request as code in four languages. Measured against
  // the build before: 34 000 more, after the float printer, a base64 decoder
  // and a sort were taken out again.
  "core.wasm": 272_000,
  // Raised once, from 16 000 and 400, for the security hardening: the checks
  // on imported files and stored secrets, the size limits, the frame guard,
  // and the page's own Content-Security-Policy.
  //
  // Raised once more, from 17 000 and 3 100, for the form of a body, the
  // pickers, the variables and the code in four languages, and for the
  // three-pane layout that shows them.
  "app.js": 24_000,
  // Raised once, from 4 600, for the roomier page: a scale of space, the
  // console's sections (`.card`), the fields of a message as a list, and
  // the joined buttons of a choice. Measured: 4 456 before, 5 135 after.
  // Then lowered, from 5 200, once `just dist` minified the style:
  // 5 135 before, 3 766 after. Raised once, from 3 900, for the footer
  // (`.foot`): 3 766 before, 3 903 after.
  "app.css": 4_000,
  "index.html": 480,
};

// Bytes as they are: a WOFF2 font is compressed already.
const FONTS: Record<string, number> = {
  "fonts/jetbrains-mono.woff2": 41_000,
  "fonts/space-grotesk.woff2": 23_000,
};

const failures: string[] = [];
let total = 0;
for (const [file, budget] of Object.entries(BUDGET)) {
  const path = `${DIST}/${file}`;
  if (!existsSync(path)) {
    failures.push(`${path} is missing: run \`just dist\``);
    continue;
  }
  const raw = readFileSync(path);
  const size = gzipSync(raw, { level: 9 }).length;
  total += size;
  const verdict = size <= budget ? "ok  " : "FAIL";
  console.log(`${verdict}  ${file.padEnd(11)} ${String(size).padStart(7)} gzip  (${raw.length} raw, budget ${budget})`);
  if (size > budget) failures.push(`${file} is ${size} bytes gzipped; the budget is ${budget}`);
}
for (const [file, budget] of Object.entries(FONTS)) {
  const path = `${DIST}/${file}`;
  if (!existsSync(path)) {
    failures.push(`${path} is missing: run \`just dist\``);
    continue;
  }
  const size = readFileSync(path).length;
  total += size;
  const verdict = size <= budget ? "ok  " : "FAIL";
  console.log(`${verdict}  ${file.padEnd(26)} ${String(size).padStart(7)} raw   (budget ${budget})`);
  if (size > budget) failures.push(`${file} is ${size} bytes; the budget is ${budget}`);
}
console.log(`      total       ${String(total).padStart(7)} sent`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
