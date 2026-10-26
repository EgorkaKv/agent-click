import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Every browser test file launches its own headless Brave; more in parallel overloads the machine.
    maxWorkers: 4,
  },
});
