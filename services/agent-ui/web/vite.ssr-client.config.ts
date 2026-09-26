import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/workspace/",
  plugins: [react()],
  build: {
    outDir: "dist/client",
    manifest: true,
    rolldownOptions: { input: "src/entry-client.tsx" },
  },
});
