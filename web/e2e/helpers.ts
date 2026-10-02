import { type Page, expect } from "@playwright/test";

import { API } from "../playwright.config";

export const GET_WIDGET = "#/fixture.v1.WidgetService/GetWidget";
export const WATCH = "#/fixture.v1.WidgetService/WatchWidgets";

/** The credentials the fixture API accepts; see internal/testserver. */
export const TOKEN = "test-token";
export const PASSWORD = "lovelace";
export const API_KEY = "test-key";

export type Credential =
  | { scheme: "none" }
  | { scheme: "bearer"; token: string }
  | { scheme: "basic"; username: string; password: string }
  | { scheme: "api-key"; name: string; location: "header" | "query"; value: string };

export const CREDENTIALS: Record<string, Credential> = {
  bearer: { scheme: "bearer", token: TOKEN },
  basic: { scheme: "basic", username: "ada", password: PASSWORD },
  "api-key-header": { scheme: "api-key", name: "X-API-Key", location: "header", value: API_KEY },
  "api-key-query": { scheme: "api-key", name: "key", location: "query", value: API_KEY },
};

export async function open(page: Page, hash = "#/"): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator("main#main")).toBeVisible();
}

/** Set the environment and its credential, through the dialog, as a person would. */
export async function configure(
  page: Page,
  environment: string,
  credential: Credential,
  options: { remember?: boolean } = {},
): Promise<void> {
  await page.getByRole("button", { name: /^Environment:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Edit").selectOption({ label: environment });
  const label = { none: "None", bearer: "Bearer token", basic: "Basic (user name and password)", "api-key": "API key" };
  await dialog.getByLabel("Authentication").selectOption({ label: label[credential.scheme] });
  if (credential.scheme === "bearer") await dialog.getByLabel("Token").fill(credential.token);
  if (credential.scheme === "basic") {
    await dialog.getByLabel("User name").fill(credential.username);
    await dialog.getByLabel("Password").fill(credential.password);
  }
  if (credential.scheme === "api-key") {
    await dialog.getByLabel("Name of the header or parameter").fill(credential.name);
    await dialog.getByLabel("Where the key goes").selectOption(credential.location);
    await dialog.getByLabel("Key", { exact: true }).fill(credential.value);
  }
  if (credential.scheme !== "none") {
    await dialog.getByLabel("Remember in this browser").setChecked(options.remember ?? false);
  }
  await dialog.getByRole("button", { name: "Save and use" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: `Environment: ${environment}` })).toBeVisible();
}

export function body(page: Page) {
  return page.getByLabel("Request body, as JSON");
}

/** Type a body as JSON. A body opens as a form: this switches first. */
export async function typeBody(page: Page, text: string): Promise<void> {
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await body(page).fill(text);
}

/** Everything the page has stored, as text. */
export async function stored(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: unknown[] = [JSON.stringify(localStorage), JSON.stringify(sessionStorage), document.cookie];
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const store of db.objectStoreNames) {
        out.push(
          await new Promise((resolve, reject) => {
            const request = db.transaction(store).objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          }),
        );
      }
      db.close();
    }
    return JSON.stringify(out);
  });
}

export async function send(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Send/ }).click();
}

/** What the API last accepted. Asked from the test, not from the page. */
export async function seen(page: Page, api = API): Promise<{ scheme: string; path: string; count: number }> {
  return (await page.request.get(`${api}/_seen`)).json();
}

export function response(page: Page) {
  return page.getByRole("region", { name: "Response", exact: true });
}
