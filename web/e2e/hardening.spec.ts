// What a hostile page, file or frame can and cannot do to the site.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { type Page, expect, test } from "@playwright/test";

import { API, API_WITH_CORS, SITE } from "../playwright.config";
import { CREDENTIALS, GET_WIDGET, TOKEN, configure, open, response, seen, send, typeBody } from "./helpers";

const PROXY = "Proxy to 127.0.0.1:18080";

function build(...args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "wirebook-"));
  execFileSync("../bin/wirebook", [
    "build",
    "--image",
    "../testdata/fixture.binpb",
    "--config",
    "../testdata/wirebook.json",
    ...args.map((arg) => arg.replace("{dir}", dir)),
  ]);
  return dir;
}

/** Serve a built directory at an origin of the test's choosing, with no header of its own: a plain static host. */
async function host(page: Page, origin: string, dir: string): Promise<void> {
  const types: Record<string, string> = {
    html: "text/html",
    js: "text/javascript",
    css: "text/css",
    wasm: "application/wasm",
    json: "application/json",
    binpb: "application/octet-stream",
    woff2: "font/woff2",
  };
  await page.route(`${origin}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1) || "index.html";
    return route.fulfill({
      body: readFileSync(join(dir, name)),
      contentType: types[name.split(".").pop()!] ?? "text/plain",
    });
  });
}

/** Whether script that is not the site's own can run in the page. */
async function runsForeignScript(page: Page): Promise<{ inline: boolean; evaluated: boolean; handler: boolean }> {
  return page.evaluate(async () => {
    const flags = window as unknown as Record<string, unknown>;
    const script = document.createElement("script");
    script.textContent = "window.__inline = true";
    document.body.appendChild(script);
    // A string as a timer is evaluated like `eval`, when it fires. (`eval`
    // called from here would not tell: the test's own code runs through the
    // debugger, which the policy lets evaluate.)
    setTimeout("window.__evaluated = true", 0);
    const image = document.createElement("img");
    image.setAttribute("onerror", "window.__handler = true");
    image.src = "data:image/png;base64,AAAA";
    document.body.appendChild(image);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      inline: flags.__inline === true,
      evaluated: flags.__evaluated === true,
      handler: flags.__handler === true,
    };
  });
}

const nothingRuns = { inline: false, evaluated: false, handler: false };

test.describe("only the site's own script runs", () => {
  test("served by wirebook serve", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) violations.push(message.text());
    });
    await open(page, GET_WIDGET);
    // The site itself breaks none of its own rules, through a whole call.
    await configure(page, PROXY, CREDENTIALS.bearer!);
    await typeBody(page, '{"id": "w1"}');
    await send(page);
    await expect(response(page).getByLabel("Response body")).toBeVisible();
    expect(violations).toEqual([]);
    expect(await runsForeignScript(page)).toEqual(nothingRuns);
  });

  test("as a directory on a plain static host", async ({ page }) => {
    await host(page, "http://static.test", build("--out", "{dir}"));
    await page.goto("http://static.test/");
    await expect(page.getByRole("heading", { level: 1, name: "Fixture API" })).toBeVisible();
    expect(await runsForeignScript(page)).toEqual(nothingRuns);
  });

  test("as one file opened from the disk", async ({ page }) => {
    const dir = build("--single-file", "{dir}/explorer.html");
    await page.goto(pathToFileURL(join(dir, "explorer.html")).href);
    await expect(page.getByRole("heading", { level: 1, name: "Fixture API" })).toBeVisible();
    expect(await runsForeignScript(page)).toEqual(nothingRuns);
  });
});

test.describe("another site cannot put the page in a frame", () => {
  const framing = (src: string) =>
    `<!doctype html><title>evil</title><iframe id="victim" src="${src}" style="width:800px;height:600px"></iframe>`;

  test("wirebook serve tells the browser not to load it", async ({ page }) => {
    await page.route("http://evil.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: framing(`${SITE}/`) }),
    );
    await page.goto("http://evil.test/");
    const frame = page.frameLocator("#victim");
    await expect(frame.getByRole("heading", { name: "Fixture API" })).toHaveCount(0);
    await expect(frame.getByRole("button", { name: /^Environment/ })).toHaveCount(0);
  });

  test("on a host that sends no such header, the page itself refuses", async ({ page }) => {
    await host(page, "http://static.test", build("--out", "{dir}"));
    await page.route("http://evil.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: framing("http://static.test/") }),
    );
    await page.goto("http://evil.test/");
    const frame = page.frameLocator("#victim");
    await expect(frame.getByText("This page does not run inside a frame of another site.")).toBeVisible();
    await expect(frame.getByRole("button", { name: /^Environment/ })).toHaveCount(0);
    await expect(frame.getByRole("navigation")).toHaveCount(0);
  });
});

test("an imported file cannot take the place of an environment, or its credential", async ({ page }) => {
  await open(page, GET_WIDGET);
  await configure(page, PROXY, CREDENTIALS.bearer!, { remember: true });
  await typeBody(page, '{"id": "w1"}');
  await send(page);
  await expect(response(page).getByLabel("Response body")).toBeVisible();

  // A file that looks like a colleague's export: the same environment, by
  // id and by name, now pointing at another server, with a credential
  // header and a planted secret for good measure.
  const before = (await seen(page, API_WITH_CORS)).count;
  const file = join(mkdtempSync(join(tmpdir(), "wirebook-")), "export.json");
  writeFileSync(
    file,
    JSON.stringify({
      wirebook: 1,
      environments: [
        {
          id: `builtin:${PROXY}`,
          name: PROXY,
          baseUrl: API_WITH_CORS,
          auth: { scheme: "bearer" },
          headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
          builtin: true,
        },
      ],
      history: [],
      secrets: [{ id: `builtin:${PROXY}`, secret: TOKEN, destination: "anything" }],
    }),
  );
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#env-import").setInputFiles(file);
  await expect(dialog.getByText("Imported 1 environments and 0 calls.")).toBeVisible();

  // The site's environment is as it was: same address, same token.
  await expect(dialog.getByLabel("Edit")).toHaveValue(`builtin:${PROXY}`);
  await expect(dialog.getByLabel("Base URL")).toHaveValue("/proxy");
  await expect(dialog.getByLabel("Token")).toHaveValue(TOKEN);
  // The imported one stands beside it, named as imported, with no token.
  await dialog.getByLabel("Edit").selectOption({ label: `${PROXY} (imported)` });
  await expect(dialog.getByLabel("Base URL")).toHaveValue(API_WITH_CORS);
  await expect(dialog.getByLabel("Token")).toHaveValue("");
  await expect(dialog.getByText("This environment comes with the site.")).toHaveCount(0);
  await expect(dialog.getByLabel(/^Name of header/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save and use" }).click();

  await expect(page.getByText("No credential is set yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  expect((await seen(page, API_WITH_CORS)).count).toBe(before);
});

test("a credential over plain http to another machine is called out", async ({ page }) => {
  await open(page, GET_WIDGET);
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "New" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Intranet");
  await dialog.getByLabel("Base URL").fill("http://api.intranet.example");
  await dialog.getByLabel("Authentication").selectOption({ label: "Bearer token" });
  await dialog.getByLabel("Token").fill(TOKEN);
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await expect(page.getByText("This address is not https: the credential travels unencrypted.")).toBeVisible();
  // To this machine, it is not.
  await configure(page, PROXY, CREDENTIALS.bearer!);
  await expect(page.getByText("the credential travels unencrypted")).toHaveCount(0);
});

test("the dialog refuses a base URL that is not what it looks like, and a credential among the headers", async ({
  page,
}) => {
  await open(page, GET_WIDGET);
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "New" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Odd");
  for (const url of [
    "//evil.example",
    "/\\evil.example",
    "https://user:pass@api.example.com",
    "https://api.example.com/?key=1",
  ]) {
    await dialog.getByLabel("Base URL").fill(url);
    await dialog.getByRole("button", { name: "Save and use" }).click();
    await expect(dialog.getByText("The base URL must start with http://, https:// or a single /")).toBeVisible();
    await expect(dialog).toBeVisible();
  }
  await dialog.getByLabel("Base URL").fill("/proxy");
  await dialog.getByRole("button", { name: "Add a header" }).click();
  for (const name of ["Authorization", "X-Vault-Token", "apikey"]) {
    await dialog.getByLabel("Name of header 1").fill(name);
    await dialog.getByLabel("Value of header 1").fill(TOKEN);
    await dialog.getByRole("button", { name: "Save and use" }).click();
    await expect(dialog.getByText(`The header ${name} is a credential. Set it under Authentication`)).toBeVisible();
  }
  await expect(dialog).toBeVisible();
});

test("the proxy answers the site's page, and no one else", async ({ page, request }) => {
  // From outside a browser: refused. curl can reach the API itself.
  const direct = await request.get(`${SITE}/proxy/fixture.v1.WidgetService/GetWidget`);
  expect(direct.status()).toBe(403);

  // From another site's page, in this browser: refused, and unread.
  await page.route("http://evil.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>evil</title>" }),
  );
  await page.goto("http://evil.test/");
  const before = (await seen(page, API)).count;
  const outcome = await page.evaluate(async (site) => {
    try {
      const answer = await fetch(`${site}/proxy/v1/widgets/w1`, { headers: { Authorization: "Bearer test-token" } });
      return `read ${answer.status}`;
    } catch {
      return "blocked";
    }
  }, SITE);
  expect(outcome).toBe("blocked");
  // A request that needs no preflight is sent by the browser all the same.
  await page.evaluate(async (site) => {
    await fetch(`${site}/proxy/v1/widgets/w1?key=test-key`, { mode: "no-cors" }).catch(() => undefined);
  }, SITE);
  expect((await seen(page, API)).count).toBe(before);
});
