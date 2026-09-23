import { defineConfig } from "vitest/config";
import { integrationAlias, integrationRoot, serviceRoot } from "./vitest.integration-paths.js";

export default defineConfig({
  root: serviceRoot,
  resolve: { alias: integrationAlias },
  test: {
    environment: "node",
    include: [`${integrationRoot}/**/*.postgres.test.ts`],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
