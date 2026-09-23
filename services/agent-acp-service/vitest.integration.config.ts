import { defineConfig } from "vitest/config";
import { integrationAlias, integrationRoot, serviceRoot } from "./vitest.integration-paths.js";

export default defineConfig({
  root: serviceRoot,
  resolve: { alias: integrationAlias },
  test: {
    environment: "node",
    include: [`${integrationRoot}/**/*.test.ts`],
    exclude: [`${integrationRoot}/**/*.postgres.test.ts`],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
