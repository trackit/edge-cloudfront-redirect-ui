// Root ESLint config (flat). Each workspace inherits this; extend per-package if needed.
import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, {
  ignores: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    // A CloudFront Functions script rather than app code. Its entry point is a
    // global `handler` the runtime calls, which looks unused from here, and the
    // runtime is not ES2015+ everywhere — so the rules this config applies are
    // the opposite of the ones that file needs. `console/ui/test/
    // cloudfront-gate.test.ts` is what actually exercises it.
    "console/ui/infra/gate.js",
  ],
});
