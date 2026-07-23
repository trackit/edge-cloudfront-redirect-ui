import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/**/*.mother.ts",
        "src/rule-types.ts",
        "src/edge-config.generated.example.ts",
      ],
    },
  },
});
