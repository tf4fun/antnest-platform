import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test/session-fixture.ts"],
    maxWorkers: 1,
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
  },
});
