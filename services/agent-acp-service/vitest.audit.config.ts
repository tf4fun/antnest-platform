import { defineConfig } from "vitest/config";

// Run the complete SDK inventory and semantic probes separately from the normal
// suites. Regressions remain real failures, never expected passes or skips.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/audit/**/*.audit.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
