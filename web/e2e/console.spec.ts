import { expect, test } from "@playwright/test";

import { API, API_WITH_CORS, SITE } from "../playwright.config";
import {
  API_KEY,
  CREDENTIALS,
  GET_WIDGET,
  PASSWORD,
  TOKEN,
  WATCH,
  body,
  configure,
  open,
  response,
  seen,
  send,
  stored,
  typeBody,
} from "./helpers";

const PROXY = "Proxy to 127.0.0.1:18080";

test.describe("every scheme reaches the API over every transport", () => {
  const transports = [
    {
      name: "Connect JSON",
      method: GET_WIDGET,
      option: "Connect · JSON over POST",
      path: "/fixture.v1.WidgetService/GetWidget",
    },
    {
      name: "Connect binary",
      method: GET_WIDGET,
      option: "Connect · binary over POST",
      path: "/fixture.v1.WidgetService/GetWidget",
    },
    { name: "Connect GET", method: GET_WIDGET, option: "Connect · GET", path: "/fixture.v1.WidgetService/GetWidget" },
    { name: "REST", method: GET_WIDGET, option: "REST · GET /v1/widgets/{id}", path: "/v1/widgets/w1" },
    {
      name: "server stream",
      method: WATCH,
      option: "Connect · JSON over POST",
      path: "/fixture.v1.WidgetService/WatchWidgets",
    },
  ];

  for (const [scheme, credential] of Object.entries(CREDENTIALS)) {
    test(scheme, async ({ page }) => {
      await open(page, GET_WIDGET);
      await configure(page, PROXY, credential);
      for (const transport of transports) {
        await test.step(transport.name, async () => {
          await open(page, transport.method);
          await page.getByLabel("Send as").selectOption({ label: transport.option });
          await typeBody(page, transport.method === WATCH ? '{"colour": "COLOUR_RED"}' : '{"id": "w1"}');
          const before = (await seen(page)).count;
          await send(page);
          if (transport.method === WATCH) {
            await expect(response(page).getByText("End of the stream.")).toBeVisible();
            await expect(response(page).locator(".frames > li")).toHaveCount(4);
          } else {
            await expect(response(page).getByLabel("Response body")).toContainText('"id": "w1"');
          }
          await expect(response(page).getByText("HTTP 200")).toBeVisible();
          // The API saw this credential, on this path, once.
          expect(await seen(page)).toEqual({ scheme, path: transport.path, count: before + 1 });
        });
      }
    });
  }
});

test("without a credential, and with a wrong one, the API's refusal is shown", async ({ page }) => {
  await open(page, GET_WIDGET);
  await configure(page, PROXY, { scheme: "none" });
  await typeBody(page, '{"id": "w1"}');
  await send(page);
  await expect(response(page).getByText("HTTP 401")).toBeVisible();
  await expect(response(page)).toContainText("unauthenticated: send a bearer token, basic credentials or an API key");

  await configure(page, PROXY, { scheme: "bearer", token: "wrong-token" });
  await send(page);
  await expect(response(page)).toContainText("unauthenticated");

  // The same over REST, where the error is a google.rpc.Status.
  await page.getByLabel("Send as").selectOption({ label: "REST · GET /v1/widgets/{id}" });
  await send(page);
  await expect(response(page).getByText("HTTP 401")).toBeVisible();
  await expect(response(page)).toContainText("unauthenticated");
});

test("an error's detail is decoded with the schema", async ({ page }) => {
  await open(page, GET_WIDGET);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  await typeBody(page, '{"id": "nope"}');
  await send(page);
  await expect(response(page).getByText("HTTP 404")).toBeVisible();
  await expect(response(page)).toContainText('not_found: no widget "nope"');
  await expect(response(page)).toContainText("Detail: fixture.v1.GetWidgetRequest");
  await expect(response(page).locator("details pre").first()).toContainText('"id": "nope"');
});

test("the API's CORS rules decide a direct call; the proxy does not need them", async ({ page }) => {
  await open(page, GET_WIDGET);
  await typeBody(page, '{"id": "w1"}');

  // An API that never heard of this origin: the browser hides its answer.
  await configure(page, "Direct, without CORS", CREDENTIALS.bearer!);
  await send(page);
  await expect(response(page).getByText("no response")).toBeVisible();
  const alert = response(page).getByRole("alert");
  await expect(alert).toContainText(`does not allow requests from ${SITE} (CORS)`);
  await expect(alert).toContainText(`wirebook serve --target ${API}`);

  // The same API, allowing this origin, with each kind of credential.
  for (const scheme of ["bearer", "api-key-header", "api-key-query"]) {
    await configure(page, "Direct, with CORS", CREDENTIALS[scheme]!);
    await send(page);
    await expect(response(page).getByLabel("Response body")).toContainText('"id": "w1"');
    expect((await seen(page, API_WITH_CORS)).scheme).toBe(scheme);
  }

  await configure(page, PROXY, CREDENTIALS.bearer!);
  await send(page);
  await expect(response(page).getByLabel("Response body")).toContainText('"id": "w1"');
});

test("a body that is not valid is explained, and cannot be sent", async ({ page }) => {
  await open(page, GET_WIDGET);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  const verdict = page.locator("#verdict");
  await expect(verdict).toHaveText("Valid GetWidgetRequest.");

  await typeBody(page, '{\n  "nope": 1\n}');
  await expect(verdict).toContainText('Line 2, column 8: unknown field "nope"');
  await expect(body(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await page.getByRole("button", { name: "Reset to the example" }).click();
  await expect(body(page)).toHaveValue('{\n  "id": ""\n}');
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  await typeBody(page, '{"id":"w1"}');
  await page.getByRole("button", { name: "Format" }).click();
  await expect(body(page)).toHaveValue('{\n  "id": "w1"\n}');
  // The keyboard sends too.
  await body(page).press("ControlOrMeta+Enter");
  await expect(response(page).getByLabel("Response body")).toContainText('"id": "w1"');
});

test("REST puts the fields in the path and the query", async ({ page }) => {
  await open(page, "#/fixture.v1.LibraryService/ListBooks");
  await configure(page, PROXY, CREDENTIALS.bearer!);
  await typeBody(
    page,
    JSON.stringify({ parent: "shelves/1", pageSize: 10, filter: { familyName: "Le Guin" }, genres: ["sf", "fantasy"] }),
  );
  await page.getByLabel("Send as").selectOption({ label: "REST · GET /v1/{parent=shelves/*}/books" });
  await page.getByText("What will be sent").click();
  await expect(page.getByLabel("Request", { exact: true })).toContainText(
    "GET /proxy/v1/shelves/1/books?page_size=10&filter.family_name=Le%20Guin&genres=sf&genres=fantasy",
  );
  await send(page);
  // The API says what it understood.
  const answer = response(page).getByLabel("Response body");
  await expect(answer).toContainText('"title": "page_size=10 family_name=Le Guin"');
  await expect(answer).toContainText('"fantasy"');
  expect((await seen(page)).path).toBe("/v1/shelves/1/books");

  // A field the path needs, and the body lacks.
  await typeBody(page, "{}");
  await expect(
    page.getByText("This request cannot be sent: the field parent has no value in the request body."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("a stream arrives frame by frame, and can end with an error", async ({ page }) => {
  await open(page, WATCH);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  await typeBody(page, '{"colour": "COLOUR_RED"}');
  await send(page);
  // The first frame is on the page while the stream is still open.
  await expect(response(page).getByText("listening")).toBeVisible();
  await expect(response(page).locator(".frames > li").first()).toContainText('"id": "a"');
  await expect(response(page).getByText("End of the stream.")).toBeVisible();
  await expect(response(page).locator(".frames > li")).toHaveCount(4);
  // Each frame is numbered, and says when it came and how big it was.
  await expect(response(page).locator(".frame-n").first()).toHaveText("#1");
  await expect(response(page).locator(".frame-n").last()).toHaveText("#4");
  await expect(response(page).locator(".frames > li").first()).toContainText(/\+\d+ ms/);

  await typeBody(page, '{"colour": "COLOUR_GREEN"}');
  await send(page);
  await expect(response(page)).toContainText("unavailable: the feed went away");
  await expect(response(page).locator(".frames > li")).toHaveCount(2);
});

test("what will be sent is shown with the credential hidden", async ({ page }) => {
  await open(page, GET_WIDGET);
  await configure(page, PROXY, CREDENTIALS["api-key-query"]!);
  await typeBody(page, '{"id": "w1"}');
  await page.getByLabel("Send as").selectOption({ label: "Connect · GET" });
  await page.getByText("What will be sent").click();
  const request = page.getByLabel("Request", { exact: true });
  await expect(request).toContainText("&key=$API_KEY");
  await expect(request).not.toContainText(API_KEY);

  await configure(page, PROXY, CREDENTIALS.basic!);
  await expect(request).toContainText("Authorization: Basic $BASIC_CREDENTIALS");
  // "ada:lovelace" in base64, which is what would be sent.
  await expect(request).not.toContainText("YWRhOmxvdmVsYWNl");
});

test("the history survives a reload; a credential does only when asked", async ({ page }) => {
  await open(page, GET_WIDGET);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  await typeBody(page, '{"id": "w1"}');
  await send(page);
  await expect(response(page).getByLabel("Response body")).toBeVisible();

  // Nothing the browser keeps holds the token.
  const kept = await stored(page);
  expect(kept).toContain("fixture.v1.WidgetService/GetWidget");
  expect(kept).not.toContain(TOKEN);

  await page.reload();
  await page.getByText("Earlier calls of this method").click();
  const past = page.locator(".history li").first();
  await expect(past).toContainText("ok");
  await expect(past).toContainText(PROXY);
  // The body can be used again; the credential has to be typed again.
  await past.getByRole("button", { name: "Use this body" }).click();
  await expect(body(page)).toHaveValue('{"id": "w1"}');
  await expect(page.getByText("No credential is set yet.")).toBeVisible();
  await expect(
    page.getByText("This request cannot be sent: the bearer token must be one word, and not empty."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  // Asked to remember: it is stored, and there after a reload.
  await configure(page, PROXY, CREDENTIALS.basic!, { remember: true });
  expect(await stored(page)).toContain(PASSWORD);
  await page.reload();
  await expect(page.getByText("No credential is set yet.")).toHaveCount(0);
  await typeBody(page, '{"id": "w1"}');
  await send(page);
  await expect(response(page).getByLabel("Response body")).toContainText('"id": "w1"');

  // And forgotten again when the box is unticked.
  await configure(page, PROXY, CREDENTIALS.basic!, { remember: false });
  expect(await stored(page)).not.toContain(PASSWORD);
});

test("an environment can be added, exported without its secret, and removed", async ({ page }) => {
  await open(page, GET_WIDGET);
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "New" }).click();

  // The form says what is missing, and puts the cursor there.
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await expect(dialog.getByText("Give the environment a name.")).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill("Mine");
  await dialog.getByLabel("Base URL").fill("api.example.com");
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await expect(
    dialog.getByText(
      "The base URL must start with http://, https:// or a single /, and hold no user name, query or backslash.",
    ),
  ).toBeVisible();
  await expect(dialog.getByLabel("Base URL")).toBeFocused();

  await dialog.getByLabel("Base URL").fill("/proxy");
  await dialog.getByLabel("Authentication").selectOption({ label: "Bearer token" });
  await dialog.getByLabel("Token").fill(TOKEN);
  await dialog.getByRole("button", { name: "Add a header" }).click();
  await dialog.getByLabel("Name of header 1").fill("X-Trace");
  await dialog.getByLabel("Value of header 1").fill("e2e");
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await expect(page.getByRole("button", { name: "Environment: Mine" })).toBeVisible();

  // The header goes with every request.
  await page.getByText("What will be sent").click();
  await expect(page.getByLabel("Request", { exact: true })).toContainText("X-Trace: e2e");
  await typeBody(page, '{"id": "w1"}');
  await send(page);
  await expect(response(page).getByLabel("Response body")).toContainText('"id": "w1"');

  // The export has the environment and the call; not the token, and not
  // the body, which is what someone typed.
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const read = async (): Promise<string> => {
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Export" }).click();
    return (await import("node:fs")).readFileSync(await (await download).path(), "utf8");
  };
  const exported = await read();
  expect(exported).toContain('"name": "Mine"');
  expect(exported).toContain("fixture.v1.WidgetService/GetWidget");
  expect(exported).not.toContain(TOKEN);
  expect(exported).not.toContain("w1");
  await expect(dialog.getByText("Exported: environments and history, without request bodies")).toBeVisible();
  // With the body, when asked.
  await dialog.getByLabel("Include request bodies in an export").check();
  const withBodies = await read();
  expect(withBodies).toContain("w1");
  expect(withBodies).not.toContain(TOKEN);

  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog.getByText("Removed.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: `Environment: ${PROXY}` })).toBeVisible();
});

test("the history can be told not to keep request bodies", async ({ page }) => {
  await open(page, GET_WIDGET);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Keep request bodies in the history")).toBeChecked();
  await dialog.getByLabel("Keep request bodies in the history").uncheck();
  await dialog.getByRole("button", { name: "Close" }).click();

  await typeBody(page, '{"id": "w1-not-kept"}');
  await send(page);
  await expect(response(page)).toContainText("not_found");
  const kept = await stored(page);
  expect(kept).toContain("fixture.v1.WidgetService/GetWidget");
  expect(kept).not.toContain("w1-not-kept");

  // The choice is kept too.
  await page.reload();
  await page.getByRole("button", { name: /^Environment:/ }).click();
  await expect(dialog.getByLabel("Keep request bodies in the history")).not.toBeChecked();
});

test("a secret is never in the page's markup", async ({ page }) => {
  await open(page, GET_WIDGET);
  await configure(page, PROXY, CREDENTIALS.basic!);
  await typeBody(page, '{"id": "w1"}');
  await send(page);
  await expect(response(page).getByLabel("Response body")).toBeVisible();
  await page.getByText("What will be sent").click();
  // Closed, the dialog holds no field at all.
  expect(await page.content()).not.toContain(PASSWORD);
  await expect(page.locator("dialog input")).toHaveCount(0);
  // Open, the field has it as its value, and the markup still does not.
  await page.getByRole("button", { name: /^Environment:/ }).click();
  await expect(page.getByRole("dialog").getByLabel("Password")).toHaveValue(PASSWORD);
  await expect(page.getByRole("dialog").getByLabel("Password")).toHaveAttribute("autocomplete", "new-password");
  expect(await page.content()).not.toContain(PASSWORD);
});

test("one API's store is not another's, at the same address", async ({ page }) => {
  await open(page, GET_WIDGET);
  const names = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));
  // The name carries the site's id, which follows its proto packages.
  const config = await (await page.request.get("/config.json")).json();
  expect(config.id).toMatch(/^[0-9a-f]{16}$/);
  expect(names).toEqual([`wirebook:${config.id}:/`]);
});
