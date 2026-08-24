import { defineConfig } from "vitest/config";

// unit tests cover the pure modules only; Workers-bound code is exercised through the dev server
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { include: ["app/**/*.test.ts"] },
});
