import { defineConfig } from "vitest/config";
import { integrationAlias, integrationRoot, serviceRoot } from "./vitest.integration-paths.js";

// Run the complete SDK inventory and semantic probes separately from the normal
// suites. Regressions remain real failures, never expected passes or skips.
export default defineConfig({
  root: serviceRoot,
  resolve: { alias: integrationAlias },
  test: {
    environment: "node",
    include: [`${integrationRoot}/audit/**/*.audit.ts`],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
