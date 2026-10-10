// The site has to load fast on a cold cache, so what it ships is held to a
// budget, gzipped, as a server sends it. A budget only goes down: when the
// build gets smaller, lower the number.
//
//   bun scripts/size-budget.ts
import { existsSync, readFileSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

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
  // Raised once, from 24 000, for the page's uplift: code told apart by
  // lightness (the tokenizer), a copy button on every block, breadcrumbs, a
  // filter on the menu, a start on the home page, a palette for search, a
  // split that resizes, the frames of a stream, and the core's file by its
  // hashed name. Measured: 22 255 before, 25 886 after.
  "app.js": 26_500,
  // Raised once, from 4 600, for the roomier page: a scale of space, the
  // console's sections (`.card`), the fields of a message as a list, and
  // the joined buttons of a choice. Measured: 4 456 before, 5 135 after.
  // Then lowered, from 5 200, once `just dist` minified the style:
  // 5 135 before, 3 766 after. Raised once, from 3 900, for the footer
  // (`.foot`): 3 766 before, 3 903 after. Raised again, from 4 000, for the
  // tokens of type and of colour (`--t-*`, `--strong`, `--hover`): 3 903
  // before, 4 073 after. Raised again, from 4 200, for the rest of the
  // page's uplift (see app.js): 4 073 before, 5 054 after. Raised again,
  // from 5 200, for the GitHub mark on the header's link to wirebook, drawn
  // as a mask so it takes the text's colour: 5 196 before, 5 646 after.
  "app.css": 5_700,
  // Raised once, from 480, for the preload of the core, the schema, the
  // config and the two fonts, and for the shell the page shows while the
  // core loads. Measured: 452 before, 625 after. Raised again, from 700,
  // for the icon drawn in the page, the description and the OpenGraph tags:
  // 625 before, 902 after.
  "index.html": 1_000,
};

// Bytes as they are: a WOFF2 font is compressed already.
const FONTS: Record<string, number> = {
  "fonts/jetbrains-mono.woff2": 41_000,
  "fonts/space-grotesk.woff2": 23_000,
};

// Brotli is what a host that precompresses sends (`just deploy`); it is
// shown beside the gzip size, and not gated: the budget is one number.
const brotli = (raw: Buffer): number =>
  brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

const failures: string[] = [];
let total = 0;
let totalBrotli = 0;
for (const [file, budget] of Object.entries(BUDGET)) {
  const path = `${DIST}/${file}`;
  if (!existsSync(path)) {
    failures.push(`${path} is missing: run \`just dist\``);
    continue;
  }
  const raw = readFileSync(path);
  const size = gzipSync(raw, { level: 9 }).length;
  const br = brotli(raw);
  total += size;
  totalBrotli += br;
  const verdict = size <= budget ? "ok  " : "FAIL";
  console.log(
    `${verdict}  ${file.padEnd(11)} ${String(size).padStart(7)} gzip ${String(br).padStart(7)} br  (${raw.length} raw, budget ${budget})`,
  );
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
  totalBrotli += size;
  const verdict = size <= budget ? "ok  " : "FAIL";
  console.log(`${verdict}  ${file.padEnd(26)} ${String(size).padStart(7)} raw   (budget ${budget})`);
  if (size > budget) failures.push(`${file} is ${size} bytes; the budget is ${budget}`);
}
console.log(`      total       ${String(total).padStart(7)} gzip ${String(totalBrotli).padStart(7)} br`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
