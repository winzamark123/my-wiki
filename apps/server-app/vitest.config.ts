import { defineConfig } from "vitest/config";

// unit tests cover pure modules; bindings are exercised through the local Worker
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
