// The palette's promise, held by a test: every pair of text and ground meets
// WCAG AA (4.5:1), and the edge of a control is told from its ground (3:1).
// The tokens are read from the stylesheet itself, so a tuned colour cannot
// drift under the line unnoticed.
import { expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../app.css"), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const tokens = Object.fromEntries(
  [...root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((match) => [match[1]!, match[2]!]),
);

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const grounds = ["ground", "panel", "raised", "hover"];
const inks = ["strong", "text", "muted", "read", "write", "stream", "ok", "error"];

test("every ink reads on every ground", () => {
  for (const ground of grounds) {
    for (const ink of inks) {
      expect(contrast(tokens[ink]!, tokens[ground]!), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("the page's ground reads on a filled button of each signal colour", () => {
  for (const fill of ["read", "write", "stream", "ok", "error"]) {
    expect(contrast(tokens.ground!, tokens[fill]!), `ground on ${fill}`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the edge of a control is told from the ground it sits on", () => {
  for (const ground of ["ground", "panel", "raised"]) {
    expect(contrast(tokens.edge!, tokens[ground]!), `edge on ${ground}`).toBeGreaterThanOrEqual(3);
  }
});
