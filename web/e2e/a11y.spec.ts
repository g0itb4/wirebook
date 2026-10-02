// Accessibility: an automated scan of every kind of page against WCAG 2.2
// AA, at the three widths the layout changes at; and the things a scan
// cannot see, done from the keyboard.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

import { CREDENTIALS, GET_WIDGET, configure, open, response, send, typeBody } from "./helpers";

async function scan(page: Page, what: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const violations = results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`,
  );
  expect(violations, what).toEqual([]);
}

for (const [name, width, height] of [
  ["three panes", 1440, 900],
  ["two panes", 1000, 900],
  ["phone", 390, 844],
] as const) {
  test.describe(name, () => {
    test.use({ viewport: { width, height } });

    test("no page has an accessibility violation", async ({ page }) => {
      await open(page);
      await scan(page, "overview");
      await open(page, "#/fixture.v1.WidgetService");
      await scan(page, "service");
      await open(page, "#/fixture.v1.Widget");
      await scan(page, "message");
      await open(page, "#/fixture.v1.Colour");
      await scan(page, "enum");
      await open(page, "#/fixture.v1.NoSuch");
      await scan(page, "not found");
      await open(page, "#/fixture.v1.LibraryService/UploadPages");
      await scan(page, "method that cannot be sent");

      await open(page, GET_WIDGET);
      await configure(page, "Proxy to 127.0.0.1:18080", CREDENTIALS.bearer!);
      await scan(page, "method, as a form");
      await open(page, "#/fixture.v1.CatalogService/CreateGadget");
      await scan(page, "method, a form with warnings");
      await page.getByLabel("Language").getByRole("button", { name: "Go" }).click();
      await scan(page, "method, with code");
      await open(page, "#/fixture.v1.CatalogService/ListGadgets");
      await page.getByRole("button", { name: "Pick rackId from ListRacks" }).click();
      await expect(page.getByRole("option", { name: /North/ })).toBeVisible();
      await scan(page, "method, with a list to pick from");
      await open(page, GET_WIDGET);
      await typeBody(page, '{"nope": 1}');
      await scan(page, "method with an invalid body");
      await typeBody(page, '{"id": "nope"}');
      await send(page);
      await expect(response(page)).toContainText("not_found");
      await scan(page, "method with an error");

      await page.getByRole("button", { name: /^Environment:/ }).click();
      await scan(page, "environment dialog");
    });

    test("no page scrolls sideways", async ({ page }) => {
      for (const hash of [
        "#/",
        "#/fixture.v1.Widget",
        "#/fixture.v1.Gadget",
        GET_WIDGET,
        "#/fixture.v1.LibraryService/GetBook",
        "#/fixture.v1.CatalogService/CreateGadget",
      ]) {
        await open(page, hash);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, hash).toBeLessThanOrEqual(0);
      }
    });
  });
}

test("the keyboard reaches everything, starting with a way past the menu", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to the content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();

  // The environment dialog holds the focus, and gives it back.
  const environment = page.getByRole("button", { name: /^Environment:/ });
  await environment.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Environment" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Edit")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(environment).toBeFocused();
});

test("on a phone the menu opens and closes, and closes on a choice", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const menu = page.getByRole("button", { name: "Menu" });
  const nav = page.getByRole("navigation", { name: "Schema" });
  await expect(nav).toBeHidden();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await nav.getByRole("link", { name: "GetWidget", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: /GetWidget/ })).toBeVisible();
  await expect(nav).toBeHidden();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
});
