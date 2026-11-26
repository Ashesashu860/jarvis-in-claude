import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: { include: ["src/domain/**", "src/application/**"], thresholds: { lines: 90 } },
  },
});
