// The site as one HTML file, opened from the disk: no server at all.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

import { CREDENTIALS, configure, typeBody } from "./helpers";

test("one file holds the page, the core and the schema", async ({ page }) => {
  const file = join(mkdtempSync(join(tmpdir(), "wirebook-")), "explorer.html");
  execFileSync("../bin/wirebook", [
    "build",
    "--image",
    "../testdata/fixture.binpb",
    "--config",
    "../testdata/wirebook.json",
    "--single-file",
    file,
  ]);

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { level: 1, name: "Fixture API" })).toBeVisible();
  // It loaded nothing but itself.
  expect(requests).toEqual([pathToFileURL(file).href]);
  await expect(page.getByRole("link", { name: "wirebook on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/g0itb4/wirebook",
  );

  // The core works: it validates, and builds a request.
  await page.goto(`${pathToFileURL(file).href}#/fixture.v1.WidgetService/GetWidget`);
  await typeBody(page, '{"id": 5}');
  await expect(page.locator("#verdict")).toContainText("Line 1, column");
  await typeBody(page, '{"id": "w1"}');
  // The config says the API takes a bearer token; none is set yet.
  await expect(
    page.getByText("This request cannot be sent: the bearer token must be one word, and not empty."),
  ).toBeVisible();
  await configure(page, "Direct, with CORS", CREDENTIALS.bearer!);
  await page.getByText("What will be sent").click();
  await expect(page.getByLabel("Request", { exact: true })).toContainText(
    "POST http://127.0.0.1:18081/fixture.v1.WidgetService/GetWidget",
  );
});
