// How fast is the core, in the runtime the browser uses? Times are medians,
// held to budgets that leave room for a slower machine: the point is to
// catch a change that makes something ten times slower, not ten percent.
//
//   just bench
import { readFileSync } from "node:fs";

import { Core } from "../web/src/lib/core";

const wasm = readFileSync("internal/site/dist/core.wasm");
const fixture = new Uint8Array(readFileSync("testdata/fixture.binpb"));
const large = new Uint8Array(readFileSync("coverage/bench.binpb"));

function median(run: () => void, times: number): number {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

// The module is compiled once; what is timed is what happens per page load
// after that, and per keystroke.
const compileStart = performance.now();
let core = await Core.load(wasm, fixture, []);
const compileMs = performance.now() - compileStart;
const big = await Core.load(wasm, large, []);

const spec = {
  method: "fixture.v1.WidgetService/GetWidget",
  body: '{"id":"w1"}',
  transport: "connect-json" as const,
  baseUrl: "http://localhost:8080",
  headers: [],
  auth: { scheme: "bearer" as const, token: "t" },
  binding: 0,
  timeoutMs: null,
};
const widget = core.template("fixture.v1.Widget");

// [what, milliseconds, budget in milliseconds]
const results: [string, number, number][] = [
  ["compile the core and load the fixture schema", compileMs, 200],
  ["load and index the fixture schema (152 kB)", median(() => void (core = Core.loadAgain(fixture, [])), 20), 15],
  [
    `load and index a large schema (${big.index.messages.length} messages, ${(large.length / 1e6).toFixed(1)} MB)`,
    median(() => void Core.loadAgain(large, []), 10),
    350,
  ],
  ["search a large schema", median(() => void big.search("field_7", 12), 20), 30],
  ["validate a body with every field kind", median(() => void core.validate("fixture.v1.Widget", widget), 200), 1],
  ["build a request", median(() => void core.request(spec), 200), 1],
];

let failed = false;
for (const [what, ms, budget] of results) {
  const ok = ms <= budget;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"}  ${ms.toFixed(2).padStart(8)} ms  (budget ${budget})  ${what}`);
}
if (failed) {
  console.error("a budget is exceeded");
  process.exit(1);
}
