import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level tests for the console.
 *
 * These run against `vite dev` with every `/api/*` call intercepted in the page
 * (see `e2e/fixtures.ts`), so nothing here needs the console API, AWS, or a
 * DynamoDB table. What they cover is what the vitest suite structurally cannot:
 * the parts that only exist once a browser has laid out the DOM, dispatched a
 * real event, or reloaded the page.
 *
 * A distinct port from `vite.config.ts`'s 5180, so a dev server someone already
 * has running is never the thing under test — and `strictPort` so a busy port
 * fails loudly instead of quietly testing a different app on the next one up.
 */
const PORT = 5199;

export default defineConfig({
  testDir: "./e2e",
  // `*.e2e.ts`, never `*.test.ts`: vitest owns that suffix, and a file picked up
  // by both runners fails confusingly in one of them.
  testMatch: /.*\.e2e\.ts/,

  // A test that has to wait on the network is stubbing something wrong.
  timeout: 10_000,
  expect: { timeout: 5_000 },

  // CI reruns the whole file on failure rather than the flake retry loop, which
  // hides a genuinely unstable test until it fails on someone else's PR.
  retries: 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL: `http://localhost:${PORT}`,
    // `retain-on-failure`, not `on-first-retry`: retries are 0, so an
    // on-retry trace would never be written and the CI artifact would always
    // be empty — exactly when it is needed.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  // Chromium alone. These assert on this app's own behaviour — focus handling,
  // storage, event order — not on anything that differs across engines, so a
  // second browser would triple the CI minutes to re-prove the same assertions.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
