// What makes a request easy: a form drawn from the schema, its rules shown
// and checked, real ids picked from the API, variables, and the request as
// code.
import { type Page, expect, test } from "@playwright/test";

import { API } from "../playwright.config";
import {
  CREDENTIALS,
  GET_WIDGET,
  TOKEN,
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
const CREATE = "#/fixture.v1.CatalogService/CreateGadget";
const LIST_GADGETS = "#/fixture.v1.CatalogService/ListGadgets";
const GET_GADGET = "#/fixture.v1.CatalogService/GetGadget";
const NORTH = "11111111-1111-4111-8111-111111111111";

const view = (page: Page, name: "Form" | "JSON") => page.getByRole("button", { name, exact: true });
const value = async (page: Page): Promise<Record<string, unknown>> =>
  JSON.parse(await body(page).inputValue()) as Record<string, unknown>;

test("the reference shows what the schema asks of each field", async ({ page }) => {
  await open(page, "#/fixture.v1.Gadget");
  const fields = page.getByRole("list", { name: "Fields of Gadget" });
  const rack = fields.getByRole("listitem").filter({ hasText: /^rackId/ });
  await expect(rack).toContainText("required");
  await expect(rack).toContainText("uuid");
  await expect(rack).toContainText("from ListRacks");
  await expect(fields.getByRole("listitem").filter({ hasText: /^title/ })).toContainText("1 to 40 characters");
  await expect(fields.getByRole("listitem").filter({ hasText: /^title/ })).toContainText("e.g. Sprocket");
  await expect(fields.getByRole("listitem").filter({ hasText: /^slots/ })).toContainText("≥ 1 · ≤ 3");
  // The example beside it starts from the schema's examples.
  await expect(page.getByLabel("Example JSON")).toContainText('"title": "Sprocket"');
});

test("the form and the JSON are two views of one body", async ({ page }) => {
  await open(page, CREATE);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  // A body opens as a form, filled from the schema's examples.
  await expect(view(page, "Form")).toHaveAttribute("aria-pressed", "true");
  const form = page.locator(".form");
  await expect(form.getByLabel("title", { exact: true })).toHaveValue("Sprocket");

  // An edit in the form is an edit of the JSON.
  await form.getByLabel("title", { exact: true }).fill("Cog");
  await form.getByLabel("slots", { exact: true }).fill("3");
  await form.getByLabel("kind", { exact: true }).selectOption("GADGET_KIND_TOY");
  await form.getByRole("button", { name: "+ tags" }).click();
  // The button that added an item keeps the focus.
  await expect(form.getByRole("button", { name: "+ tags" })).toBeFocused();
  await form.getByLabel("tags 2", { exact: true }).fill("blue");
  await form.getByRole("button", { name: "+ labels" }).click();
  await form.getByLabel("Key 2 of labels").fill("shelf");
  await form.getByLabel("Key 2 of labels").press("Tab");
  await form.getByLabel("Value of shelf in labels").fill("top");
  const gadget = (await value(page)).gadget as Record<string, unknown>;
  expect(gadget.title).toBe("Cog");
  // A number is a number in the JSON, not a text.
  expect(gadget.slots).toBe(3);
  expect(gadget.kind).toBe("GADGET_KIND_TOY");
  expect((gadget.tags as string[])[1]).toBe("blue");
  expect((gadget.labels as Record<string, string>).shelf).toBe("top");

  // A nested message is put there on demand, and taken away again.
  await form.getByRole("button", { name: "+ spare", exact: true }).click();
  await form.getByRole("group", { name: "spare", exact: true }).getByLabel("title", { exact: true }).fill("Spare cog");
  expect(((await value(page)).gadget as { spare: { title: string } }).spare.title).toBe("Spare cog");
  await form.getByRole("button", { name: "× spare" }).click();
  expect((await value(page)).gadget).not.toHaveProperty("spare");

  // An edit of the JSON is an edit of the form.
  await typeBody(page, '{"gadget": {"title": "From JSON", "slots": 1}}');
  await view(page, "Form").click();
  await expect(form.getByLabel("title", { exact: true })).toHaveValue("From JSON");
  await expect(form.getByLabel("slots", { exact: true })).toHaveValue("1");

  // What is not a JSON object has no form, and says so.
  await typeBody(page, "[1, 2");
  await view(page, "Form").click();
  await expect(page.getByText("The body is not a JSON object, so it has no form.")).toBeVisible();
  await page.getByRole("button", { name: "Reset to the example" }).click();
  await expect(form.getByLabel("title", { exact: true })).toHaveValue("Sprocket");

  // The view that was chosen is the view after a reload.
  await view(page, "JSON").click();
  // The choice is written to the browser's store; a reload before that is
  // done would not find it.
  await expect.poll(() => stored(page)).toContain('{"id":"view","value":"json"}');
  await page.reload();
  await expect(view(page, "JSON")).toHaveAttribute("aria-pressed", "true");
  await expect(body(page)).toBeVisible();
});

test("a rule that is not met is a warning: the request can still be sent", async ({ page }) => {
  await open(page, CREATE);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  const form = page.locator(".form");
  // The warning is at its field, and tied to it.
  const rack = form.getByLabel("rackId", { exact: true });
  await expect(rack).toHaveAccessibleDescription("is required");
  await form.getByLabel("slots", { exact: true }).fill("9");
  await expect(form.getByLabel("slots", { exact: true })).toHaveAccessibleDescription("must be ≤ 3");
  await expect(page.locator("#verdict")).toContainText("of the schema not met: the server may refuse it.");
  // As JSON, the same warnings are a list under the body.
  await view(page, "JSON").click();
  const warnings = page.getByRole("list", { name: "Rules of the schema this body does not meet" });
  await expect(warnings).toContainText("gadget.slots must be ≤ 3");

  // The server is the one that decides: here it takes the gadget.
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await send(page);
  await expect(response(page).getByText("HTTP 200")).toBeVisible();

  // A rule met takes its warning away.
  await view(page, "Form").click();
  await form.getByLabel("slots", { exact: true }).fill("2");
  await expect(form.getByLabel("slots", { exact: true })).toHaveAccessibleDescription("");
});

test("an id is picked from the API: one call, after the click and not before", async ({ page }) => {
  await open(page, LIST_GADGETS);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  const form = page.locator(".form");
  const pick = page.getByRole("button", { name: "Pick rackId from ListRacks" });
  await expect(pick).toBeVisible();
  const before = (await seen(page)).count;

  await pick.click();
  const racks = page.getByRole("listbox", { name: "Rack to pick from" });
  await expect(racks.getByRole("option")).toHaveCount(2);
  // The API saw one call, with the credential, of the list the button named.
  expect(await seen(page)).toEqual({
    scheme: "bearer",
    path: "/fixture.v1.CatalogService/ListRacks",
    count: before + 1,
  });
  await page.getByLabel("Filter ListRacks").fill("nor");
  await expect(racks.getByRole("option")).toHaveCount(1);
  await racks.getByRole("option", { name: /North/ }).click();
  await expect(form.getByLabel("rackId", { exact: true })).toHaveValue(NORTH);
  await expect(racks).toBeHidden();
  await expect(pick).toBeFocused();

  // Opened again, the list is shown from memory: no second call.
  await pick.click();
  await expect(racks.getByRole("option")).toHaveCount(2);
  expect((await seen(page)).count).toBe(before + 1);

  // What was listed is in the tab's memory only.
  expect(await stored(page)).not.toContain("North");
  expect(await stored(page)).not.toContain(NORTH);
});

test("a list that needs another id says which, pages, and is not offered where the schema is not clear", async ({
  page,
}) => {
  // The gadgets are listed by rack: without one, the picker says so, and
  // calls nothing.
  await open(page, GET_GADGET);
  await configure(page, PROXY, CREDENTIALS.bearer!);
  const before = (await seen(page)).count;
  const pick = page.getByRole("button", { name: "Pick gadgetId from ListGadgets" });
  await pick.click();
  await expect(page.getByText("ListGadgets needs rackId: set it first")).toBeVisible();
  expect((await seen(page)).count).toBe(before);
  await page.getByRole("button", { name: "close" }).click();

  // A variable of the environment gives it the rack.
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add a variable" }).click();
  await dialog.getByLabel("Name of variable 1").fill("rackId");
  await dialog.getByLabel("Value of variable 1").fill(NORTH);
  await dialog.getByLabel("Token").fill(TOKEN);
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await pick.click();
  const gadgets = page.getByRole("listbox", { name: "Gadget to pick from" });
  // A page of the list, then the rest of it.
  await expect(gadgets.getByRole("option")).toHaveCount(20);
  await page.getByRole("button", { name: "more", exact: true }).click();
  await expect(gadgets.getByRole("option")).toHaveCount(25);
  await expect(page.getByRole("button", { name: "more", exact: true })).toHaveCount(0);
  await gadgets.getByRole("option").first().click();
  await send(page);
  await expect(response(page).getByText("HTTP 200")).toBeVisible();

  // No picker where the schema names no list, two lists, or a list that is
  // not declared free of side effects.
  await open(page, CREATE);
  await expect(page.getByRole("button", { name: "Pick rackId from ListRacks" })).toBeVisible();
  for (const field of ["ownerId", "partId", "crateId"]) {
    await expect(page.locator(".form").getByLabel(field, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(`^Pick ${field}`) })).toHaveCount(0);
  }
});

test("an id seen in a response is offered without a call", async ({ page }) => {
  await open(page, "#/fixture.v1.CatalogService/ListRacks");
  await configure(page, PROXY, CREDENTIALS.bearer!);
  await send(page);
  await expect(response(page).getByLabel("Response body")).toContainText("North");
  const before = (await seen(page)).count;

  await page
    .getByRole("navigation", { name: "Schema" })
    .getByRole("link", { name: "ListGadgets", exact: true })
    .click();
  await page.getByRole("button", { name: "Pick rackId from ListRacks" }).click();
  await expect(page.getByText('2 seen in responses. "list" calls ListRacks.')).toBeVisible();
  await page.getByRole("option", { name: /South/ }).click();
  await expect(page.locator(".form").getByLabel("rackId", { exact: true })).toHaveValue(/^2222/);
  expect((await seen(page)).count).toBe(before);
});

test("a variable of the environment fills a body, and an unset one is named", async ({ page }) => {
  await open(page, LIST_GADGETS);
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Token").fill(TOKEN);
  await dialog.getByRole("button", { name: "Add a variable" }).click();

  // A variable is stored and exported: a credential does not go there.
  await dialog.getByLabel("Name of variable 1").fill("api_token");
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await expect(dialog.getByText("The variable api_token is named like a credential.")).toBeVisible();
  await dialog.getByLabel("Name of variable 1").fill("rack id");
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await expect(dialog.getByText("The variable rack id cannot be written {{…}}")).toBeVisible();
  await dialog.getByLabel("Name of variable 1").fill("rackId");
  await dialog.getByLabel("Value of variable 1").fill(NORTH);
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await expect(dialog).toBeHidden();

  // A field named as a variable starts with it.
  await page.getByRole("button", { name: "Reset to the example" }).click();
  await expect(page.locator(".form").getByLabel("rackId", { exact: true })).toHaveValue("{{rackId}}");
  await expect(page.locator("#verdict")).toHaveText("Valid ListGadgetsRequest.");
  // What is sent has the value; what the history keeps has the placeholder.
  await page.getByText("What will be sent").click();
  await expect(page.getByLabel("Request", { exact: true })).toContainText(`"rackId":"${NORTH}"`);
  await send(page);
  await expect(response(page).getByLabel("Response body")).toContainText("Gadget 1");
  const kept = await stored(page);
  expect(kept).toContain("{{rackId}}");

  // A variable that is not set is named, and the request is not sent.
  await typeBody(page, '{"rackId": "{{nope}}"}');
  await expect(page.locator("#verdict")).toContainText("the variable nope is not set in this environment");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("the request as code, in four languages, hides the credential unless asked", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "#/fixture.v1.WidgetService/GetWidget");
  await configure(page, PROXY, CREDENTIALS.bearer!);
  await typeBody(page, '{"id": "w1"}');
  const code = page.getByLabel("The request as code");
  const language = (name: string) => page.getByLabel("Language").getByRole("button", { name, exact: true });

  // To the API itself, not to the proxy: code has no CORS to get around.
  await expect(language("curl")).toHaveAttribute("aria-pressed", "true");
  await expect(code).toContainText(`curl --globoff -X POST '${API}/fixture.v1.WidgetService/GetWidget'`);
  await expect(code).toContainText(`-H 'Authorization: Bearer '"$TOKEN"`);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByText("Copied.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await code.textContent());

  const marks: Record<string, string[]> = {
    fetch: [`await fetch("${API}/fixture.v1.WidgetService/GetWidget"`, "process.env.TOKEN"],
    Python: ["import requests", 'os.environ["TOKEN"]'],
    Go: ["http.NewRequest(", 'os.Getenv("TOKEN")'],
  };
  for (const [name, wanted] of Object.entries(marks)) {
    await language(name).click();
    await expect(language(name)).toHaveAttribute("aria-pressed", "true");
    for (const text of wanted) await expect(code).toContainText(text);
    await expect(code).not.toContainText(TOKEN);
  }

  // With the credential, when asked; and the copy says so.
  await page.getByLabel("include the credential").check();
  await expect(code).toContainText(TOKEN);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByText("Copied, with the credential in it.")).toBeVisible();
  // The language stays as chosen on another method.
  await page.getByRole("navigation", { name: "Schema" }).getByRole("link", { name: "ListRacks", exact: true }).click();
  await expect(language("Go")).toHaveAttribute("aria-pressed", "true");
  await expect(code).toContainText("ListRacks");
});

test.describe("the look", () => {
  test("three panes when wide, with the console in view; fonts are the site's own", async ({ page }) => {
    const fonts: string[] = [];
    page.on("response", (answer) => {
      if (answer.url().endsWith(".woff2")) fonts.push(`${answer.status()} ${new URL(answer.url()).pathname}`);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, CREATE);
    const boxes = async () => ({
      nav: (await page.getByRole("navigation", { name: "Schema" }).boundingBox())!,
      reference: (await page.getByRole("heading", { level: 1 }).boundingBox())!,
      console: (await page.getByRole("region", { name: "Console and examples" }).boundingBox())!,
    });
    const wide = await boxes();
    expect(wide.nav.x).toBeLessThan(wide.reference.x);
    expect(wide.reference.x).toBeLessThan(wide.console.x);
    // Side by side: the console starts at the top, beside the reference.
    expect(wide.console.y).toBeLessThan(100);
    // Scrolled, the console is still there.
    await page.mouse.wheel(0, 2000);
    await expect(page.getByRole("button", { name: "Send" })).toBeInViewport();

    // Narrower, the console is under the reference.
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const mid = await boxes();
    expect(mid.console.y).toBeGreaterThan(mid.reference.y + 100);

    await page.evaluate(() => document.fonts.ready);
    expect(fonts.sort()).toEqual(["200 /fonts/jetbrains-mono.woff2", "200 /fonts/space-grotesk.woff2"]);
    expect(await page.evaluate(() => document.fonts.check('1rem "JetBrains Mono"'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  });

  test("code is told apart by lightness, and every block can be copied", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, "#/fixture.v1.Widget");
    const example = page.getByLabel("Example JSON");
    await expect(example.locator(".tk-key").first()).toHaveText('"id"');
    await page.getByRole("button", { name: "Copy the example" }).click();
    await expect(page.getByRole("button", { name: "Copy the example" })).toHaveText(/Copied/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"id":');

    await open(page, GET_WIDGET);
    await configure(page, PROXY, CREDENTIALS.bearer!);
    await typeBody(page, '{"id": "w1"}');
    await send(page);
    const body = response(page).getByLabel("Response body");
    await expect(body.locator(".tk-key").first()).toHaveText('"widget"');
    await expect(body.locator(".tk-str").first()).toHaveText('"w1"');
    await response(page).getByRole("button", { name: "Copy the response" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"id": "w1"');
    // The request as code is highlighted too, in each language.
    await expect(page.getByLabel("The request as code").locator(".tk-kw").first()).toHaveText("curl");
  });

  test("on a phone, the method page offers a way down to its console", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, GET_WIDGET);
    const transport = page.getByLabel("Send as");
    await page.getByRole("button", { name: "Try it" }).click();
    await expect(transport).toBeFocused();
    await expect(transport).toBeInViewport();
  });

  test("the navigation says what each method does", async ({ page }) => {
    await open(page);
    const nav = page.getByRole("navigation", { name: "Schema" });
    const tag = (method: string) => nav.getByRole("link", { name: method, exact: true }).locator(".tag");
    await expect(tag("GetWidget")).toHaveText("R");
    await expect(tag("CreateWidget")).toHaveText("W");
    await expect(tag("WatchWidgets")).toHaveText("S");
    // The letter is for the eye; the link is still named by its method.
    await expect(nav.getByRole("link", { name: "GetWidget", exact: true })).toBeVisible();
  });

  const animation = (page: Page) =>
    response(page)
      .locator(".status")
      .evaluate((status) => getComputedStyle(status).animationName);

  test("an error arrives with one jolt; with reduced motion, with none", async ({ page }) => {
    await open(page, "#/fixture.v1.WidgetService/GetWidget");
    await configure(page, PROXY, CREDENTIALS.bearer!);
    await typeBody(page, '{"id": "nope"}');
    await send(page);
    await expect(response(page).getByText("HTTP 404")).toBeVisible();
    expect(await animation(page)).toBe("glitch");
    // Once: it does not loop.
    expect(
      await response(page)
        .locator(".status")
        .evaluate((status) => getComputedStyle(status).animationIterationCount),
    ).toBe("1");
    // A good answer has none.
    await typeBody(page, '{"id": "w1"}');
    await send(page);
    await expect(response(page).getByText("HTTP 200")).toBeVisible();
    expect(await animation(page)).toBe("none");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await typeBody(page, '{"id": "nope"}');
    await send(page);
    await expect(response(page).getByText("HTTP 404")).toBeVisible();
    expect(await animation(page)).toBe("none");
  });

  test("the shortcut of one key can be turned off", async ({ page }) => {
    await open(page);
    const search = page.getByRole("combobox", { name: "Search the schema" });
    await expect(search).toHaveAttribute("placeholder", /\//);
    await page.getByRole("button", { name: /^Environment:/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Keyboard shortcuts of one key").uncheck();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(search).toHaveAttribute("placeholder", "Search");
    await page.locator("main").focus();
    await page.keyboard.press("/");
    await expect(search).not.toBeFocused();
    // And it stays off.
    await page.reload();
    await page.locator("main").focus();
    await page.keyboard.press("/");
    await expect(search).not.toBeFocused();
    await expect(search).toHaveAttribute("placeholder", "Search");
  });

  test("the environment says when it has no credential yet", async ({ page }) => {
    await open(page);
    const chip = page.getByRole("button", { name: /^Environment:/ });
    await expect(chip).toContainText("no credential yet");
    await configure(page, PROXY, CREDENTIALS.bearer!);
    await expect(chip).not.toContainText("no credential yet");
  });
});
