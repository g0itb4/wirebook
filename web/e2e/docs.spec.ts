import { expect, test } from "@playwright/test";

import { open } from "./helpers";

test("the overview lists the services and their methods", async ({ page }) => {
  await open(page);
  await expect(page).toHaveTitle("Fixture API");
  await expect(page.getByRole("heading", { level: 1, name: "Fixture API" })).toBeVisible();
  const main = page.locator("main");
  await expect(main.getByRole("link", { name: "fixture.v1.WidgetService" })).toBeVisible();
  await expect(main.getByRole("link", { name: "GetWidget", exact: true })).toBeVisible();
  await expect(main.getByText("One widget by id. Has no side effects, so Connect allows GET.")).toBeVisible();
  // The files of the site, with their syntax; the imports are not listed.
  const files = main.getByRole("table", { name: "The proto files this site documents" });
  await expect(files.getByRole("row", { name: /editions\.proto.*edition 2024/ })).toBeVisible();
  await expect(files.getByRole("row", { name: /library\.proto.*edition 2023/ })).toBeVisible();
  await expect(files.getByRole("row", { name: /proto2\.proto.*proto2/ })).toBeVisible();
  await expect(files.getByText("google/protobuf/timestamp.proto")).toHaveCount(0);
});

test("the menu leads to a message, whose fields link to their types", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "Schema" }).getByRole("link", { name: "Widget", exact: true }).click();
  await expect(page).toHaveURL(/#\/fixture\.v1\.Widget$/);
  await expect(page).toHaveTitle("Widget · Fixture API");
  await expect(page.getByRole("heading", { level: 1, name: "fixture.v1.Widget" })).toBeVisible();
  // A new page takes the focus, so reading starts at its top.
  await expect(page.locator("main")).toBeFocused();
  await expect(
    page.getByRole("navigation", { name: "Schema" }).getByRole("link", { name: "Widget", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  const fields = page.getByRole("list", { name: "Fields of Widget" });
  const serial = fields.getByRole("listitem").filter({ hasText: /^serial/ });
  await expect(serial).toContainText("int64");
  await expect(serial).toContainText("64-bit integers are strings in JSON.");
  await expect(fields.getByRole("listitem").filter({ hasText: /partsBySerial/ })).toContainText(
    "map<int64, Widget.Part>",
  );
  await expect(fields.getByRole("listitem").filter({ hasText: /salvagedFrom/ })).toContainText("oneof source");
  await expect(page.getByLabel("Example JSON")).toContainText('"serial": "0"');
  // Who uses it: the messages that hold one, and through them the methods.
  const users = page.getByRole("list", { name: "Used by" });
  await expect(users.getByRole("link", { name: "fixture.v1.CreateWidgetRequest" })).toBeVisible();
  await expect(users.getByRole("link", { name: "fixture.v1.GetWidgetResponse" })).toBeVisible();

  await fields.getByRole("link", { name: "Colour" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "fixture.v1.Colour" })).toBeVisible();
  await expect(page.getByText("Open: a number that is not listed is kept as a number.")).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Values of Colour" }).getByRole("row", { name: /COLOUR_GREEN/ }),
  ).toContainText("2");
});

test("a deep link opens its page, and a wrong one says so", async ({ page }) => {
  await open(page, "#/fixture.v1.LibraryService/UpdateBook");
  await expect(page.getByRole("heading", { level: 1, name: /UpdateBook/ })).toBeVisible();
  // Where it is: the package, the service it belongs to, and what it is.
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toContainText("fixture.v1");
  await expect(crumbs.getByRole("link", { name: "LibraryService" })).toHaveAttribute(
    "href",
    "#/fixture.v1.LibraryService",
  );
  await expect(crumbs.getByText("Method")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("PATCH /v1/{book.name=shelves/*/books/*}").first()).toBeVisible();

  await open(page, "#/fixture.v1.NoSuchThing");
  await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
  await expect(page.getByText("fixture.v1.NoSuchThing")).toBeVisible();
});

test("search is driven from the keyboard", async ({ page }) => {
  await open(page);
  await page.keyboard.press("/");
  const search = page.getByRole("combobox", { name: "Search the schema" });
  await expect(search).toBeFocused();
  await search.pressSequentially("getwidget");
  const results = page.getByRole("listbox", { name: "Search results" });
  await expect(results.getByRole("option").first()).toContainText("fixture.v1.WidgetService/GetWidget");
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/fixture\.v1\.WidgetService\/GetWidget$/);
  await expect(results).toBeHidden();
  // The new page has the focus, so "/" is a shortcut again, not a character.
  await expect(page.locator("main")).toBeFocused();

  // Arrows move through the results; Escape gives up.
  await page.keyboard.press("/");
  await search.pressSequentially("colour");
  await expect(results.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(results.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(results).toBeHidden();
  await expect(search).toHaveValue("");

  await search.fill("zzzz");
  await expect(results).toContainText("Nothing matches.");
});

test("a method with a client stream is documented, and says why it cannot be called", async ({ page }) => {
  await open(page, "#/fixture.v1.LibraryService/UploadPages");
  await expect(page.getByText("client stream", { exact: true })).toBeVisible();
  await expect(page.getByText("A browser cannot send one, so it cannot be called from this page.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Send/ })).toHaveCount(0);
});

test("a request message names the method that takes it", async ({ page }) => {
  await open(page, "#/fixture.v1.GetWidgetRequest");
  const users = page.getByRole("list", { name: "Used by" });
  await expect(users.getByRole("link", { name: "fixture.v1.WidgetService/GetWidget" })).toBeVisible();
});

test("every page names wirebook, and the site's own links", async ({ page }) => {
  await open(page, "#/fixture.v1.WidgetService/GetWidget");
  // Inside main, a footer is not the page's contentinfo landmark: find it by element.
  const foot = page.locator("footer");
  await expect(foot.getByRole("link", { name: "wirebook on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/g0itb4/wirebook",
  );
  await expect(foot.getByRole("link", { name: "Fixture docs" })).toHaveAttribute("href", "https://example.com/fixture");
});

test("a deprecated declaration is marked", async ({ page }) => {
  await open(page, "#/fixture.legacy.v1.OldThing");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("deprecated");
  await expect(
    page.getByRole("list", { name: "Fields of OldThing" }).getByRole("listitem").filter({ hasText: /title/ }),
  ).toContainText("deprecated");
});
