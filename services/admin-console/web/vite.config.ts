import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "ANTNEST_");
  return {
    plugins: [react()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      proxy: {
        "/api": env.ANTNEST_CONSOLE_API_URL || "http://127.0.0.1:8090",
      },
    },
  };
});
