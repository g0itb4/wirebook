// How fast the page is up, measured in the browser: the marks main.ts sets,
// the browser's own paint and layout-shift entries, and the files it asked
// for. The budgets are loose, like bench.ts's: a ten-times regression fails,
// a slow machine does not.
import { expect, test } from "@playwright/test";

import { open } from "./helpers";

type Marks = Record<string, number>;

async function marks(page: import("@playwright/test").Page): Promise<Marks> {
  return page.evaluate(() =>
    Object.fromEntries(
      performance.getEntriesByType("mark").map((entry) => [entry.name.replace("wirebook:", ""), entry.startTime]),
    ),
  );
}

test("the files come down together, the core compiles as it arrives, and the shell paints first", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") warnings.push(message.text());
  });
  await open(page);
  await expect.poll(async () => (await marks(page)).painted).toBeDefined();
  const m = await marks(page);
  const paint = await page.evaluate(() =>
    Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime])),
  );
  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => ({ name: new URL(entry.name).pathname, start: entry.startTime })),
  );

  // Each file once: a preload that did not match its fetch would show twice.
  const names = resources.map((resource) => resource.name).sort();
  expect(names).toEqual(
    [
      "/app.css",
      "/app.js",
      "/config.json",
      "/core.wasm",
      "/fonts/jetbrains-mono.woff2",
      "/fonts/space-grotesk.woff2",
      "/schema.binpb",
    ].sort(),
  );
  // The core was asked for by the page's head, with the script, not after it ran.
  const start = (name: string) => resources.find((resource) => resource.name === name)!.start;
  expect(start("/core.wasm") - start("/app.js")).toBeLessThan(50);
  expect(start("/schema.binpb") - start("/app.js")).toBeLessThan(50);
  // The shell is painted before the core is here.
  expect(paint["first-contentful-paint"]).toBeLessThan(m.core!);
  // Time budgets, ten times what a laptop takes.
  expect(paint["first-contentful-paint"]).toBeLessThan(2_000);
  expect(m.core! - m.boot!).toBeLessThan(2_000);
  expect(m.painted! - m.core!).toBeLessThan(500);
  // The browser said nothing about the preloads or the streaming compile.
  expect(warnings.filter((text) => /preload|instantiateStreaming/i.test(text))).toEqual([]);

  // Nothing moved when the page replaced its shell.
  const shift = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) total += (entry as PerformanceEntry & { value: number }).value;
        });
        observer.observe({ type: "layout-shift", buffered: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(total);
        }, 100);
      }),
  );
  expect(shift).toBeLessThan(0.01);
});
