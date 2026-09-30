// The coverage gate of the Rust crates: every source file is held to the
// floor of its directory in crates/coverage.json, and a file under no floor
// fails, so new code cannot arrive without a decision about how well it is
// tested. The Go side has the same gate in internal/covergate.
//
// A line counts as covered when any test ran it. The comparison is in lines,
// not in percent, so 100 means every line.
//
//   bun scripts/lcov-gate.ts coverage/rust.lcov
import { readFileSync } from "node:fs";
import { relative } from "node:path";

interface Config {
  /** Path prefixes the gate ignores. */
  exclude: string[];
  /** Path prefix to minimum line coverage, in percent. The longest wins. */
  floors: Record<string, number>;
}

const profile = process.argv[2];
if (!profile) {
  console.error("usage: bun scripts/lcov-gate.ts <profile.lcov>");
  process.exit(2);
}
const config = JSON.parse(readFileSync("crates/coverage.json", "utf8")) as Config;

// file -> line -> hit
const files = new Map<string, Map<number, boolean>>();
let current: Map<number, boolean> | undefined;
for (const line of readFileSync(profile, "utf8").split("\n")) {
  if (line.startsWith("SF:")) {
    const path = relative(process.cwd(), line.slice(3));
    current = files.get(path) ?? new Map();
    files.set(path, current);
  } else if (line.startsWith("DA:") && current) {
    const [number, hits] = line.slice(3).split(",").map(Number);
    current.set(number!, (current.get(number!) ?? false) || hits! > 0);
  }
}

const under = (prefix: string, path: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
let failed = false;
for (const [path, lines] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  if (config.exclude.some((prefix) => under(prefix, path))) continue;
  const total = lines.size;
  const covered = [...lines.values()].filter(Boolean).length;
  const percent = total === 0 ? 100 : (100 * covered) / total;
  const prefix = Object.keys(config.floors)
    .filter((candidate) => under(candidate, path))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix === undefined) {
    failed = true;
    console.log(
      `FAIL  ${path.padEnd(36)} ${percent.toFixed(1).padStart(6)}%  no floor: add one to crates/coverage.json`,
    );
    continue;
  }
  const floor = config.floors[prefix]!;
  const ok = covered * 100 >= floor * total;
  failed ||= !ok;
  const missed = [...lines].filter(([, hit]) => !hit).map(([number]) => number);
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${path.padEnd(36)} ${percent.toFixed(1).padStart(6)}%  floor ${floor}%` +
      (ok ? "" : `  lines not run: ${missed.join(", ")}`),
  );
}
if (files.size === 0) {
  console.error(`${profile} names no file: did the tests run?`);
  process.exit(1);
}
if (failed) {
  console.error("coverage is below a floor; add tests, do not lower the floor");
  process.exit(1);
}
