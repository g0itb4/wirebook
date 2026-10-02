// The agent index (llm/index.md) is loaded into every agent session through
// CLAUDE.md, so it has to stay short, and every pointer in it has to be true:
// a path that has moved sends an agent to the wrong place with confidence.
//
//   bun scripts/llm-index-check.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ENTRY = "CLAUDE.md";
const INDEX = "llm/index.md";
const IMPORT = `@${INDEX}`;

// Lines bound how much there is to read; bytes stop a long line from hiding
// a paragraph.
const BUDGET = {
  [ENTRY]: { lines: 20, bytes: 1024 },
  [INDEX]: { lines: 80, bytes: 8 * 1024 },
};

const failures: string[] = [];

function read(path: string): string {
  if (!existsSync(path)) {
    failures.push(`${path} is missing`);
    return "";
  }
  const text = readFileSync(path, "utf8");
  const lines = text.trimEnd().split("\n").length;
  const bytes = Buffer.byteLength(text);
  const budget = BUDGET[path as keyof typeof BUDGET];
  if (lines > budget.lines) failures.push(`${path} has ${lines} lines; the budget is ${budget.lines}`);
  if (bytes > budget.bytes) failures.push(`${path} has ${bytes} bytes; the budget is ${budget.bytes}`);
  return text;
}

const entry = read(ENTRY);
if (entry !== "" && !entry.split("\n").some((line) => line.trim() === IMPORT)) {
  failures.push(`${ENTRY} does not import the index: it needs a line that reads ${IMPORT}`);
}

const index = read(INDEX);
const spans = [...index.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);

// A code span is a path when it has no space and either a slash or a file
// extension. That leaves out identifiers (`WatchFleet`) and commands.
const isPath = (span: string) => !/\s/.test(span) && (span.includes("/") || /\.\w+$/.test(span));

// Generated directories are absent on a fresh clone, before `just gen`. They
// are ignored by git, and that is how they are told from a path that is wrong.
const ignored = (path: string) => spawnSync("git", ["check-ignore", "-q", path]).status === 0;

for (const path of new Set(spans.filter(isPath))) {
  if (!existsSync(path) && !ignored(path)) failures.push(`${INDEX} names \`${path}\`, which does not exist`);
}

const summary = spawnSync("just", ["--summary"], { encoding: "utf8" });
if (summary.status !== 0) {
  failures.push("`just --summary` failed, so the recipes named in the index could not be checked");
} else {
  const recipes = new Set(summary.stdout.split(/\s+/));
  for (const span of new Set(spans)) {
    const recipe = /^just ([\w-]+)/.exec(span)?.[1];
    if (recipe !== undefined && !recipes.has(recipe)) {
      failures.push(`${INDEX} names \`just ${recipe}\`, which is not a recipe`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `${INDEX}: ${index.trimEnd().split("\n").length} lines, ${Buffer.byteLength(index)} bytes, every path and recipe exists`,
);
