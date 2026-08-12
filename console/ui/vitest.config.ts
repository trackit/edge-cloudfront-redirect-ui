import { defineConfig, coverageConfigDefaults } from "vitest/config";

// No `environment: "jsdom"` and no React plugin: phase 1 covers the API client
// and the store's pure functions, none of which need a DOM. The component and
// flow tests that do are phase 2 (Playwright), per the testing ticket.
export default defineConfig({
  test: {
    // Playwright owns e2e/. Without this, vitest collects those files, fails to
    // resolve the runner's fixtures, and reports it as a broken unit suite.
    // This replaces vitest's defaults rather than adding to them, so the
    // node_modules pattern has to be restated — and with `**/` in front, since
    // a bare `node_modules/**` only anchors at the project root.
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Only what these tests can reach. The components and the `useDistributions`
      // hook are excluded rather than counted as uncovered — phase 2 owns them,
      // and listing them here would report a number that cannot move.
      include: [
        "src/akamaiImport.ts",
        "src/api/client.ts",
        "src/api/error.ts",
        "src/api/types.ts",
        "src/distribution.ts",
      ],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
