// The end-to-end tier: the built site, served by `wirebook serve`, in a real
// browser, calling the fixture API. `just e2e` builds what it needs first.
import { defineConfig, devices } from "@playwright/test";

export const SITE = "http://127.0.0.1:19000";
/** The API, without CORS: reachable through the proxy only. */
export const API = "http://127.0.0.1:18080";
/** The same API, allowing the site's origin. */
export const API_WITH_CORS = "http://127.0.0.1:18081";

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  fullyParallel: false,
  // The tests share one API, and ask it what it last saw.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  // A run that hangs is stopped, not waited for.
  globalTimeout: 5 * 60_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: SITE, trace: "retain-on-failure", actionTimeout: 10_000, navigationTimeout: 10_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    { command: "../bin/testserver --addr 127.0.0.1:18080", url: `${API}/_seen`, reuseExistingServer: false },
    {
      command: `../bin/testserver --addr 127.0.0.1:18081 --cors-origin ${SITE}`,
      url: `${API_WITH_CORS}/_seen`,
      reuseExistingServer: false,
    },
    {
      command: `../bin/wirebook serve --image ../testdata/fixture.binpb --config ../testdata/wirebook.json --target ${API} --addr 127.0.0.1:19000`,
      url: SITE,
      reuseExistingServer: false,
    },
  ],
});
