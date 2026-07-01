import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
