import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Dev-only HTTP adapter; exercised by hand, not in CI.
      exclude: [...coverageConfigDefaults.exclude, "src/local.ts"],
    },
  },
});
