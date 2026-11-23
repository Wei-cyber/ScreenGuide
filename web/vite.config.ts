import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(webRoot, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");
  return {
    root: webRoot,
    envDir: projectRoot,
    base: env.WEB_BASE_PATH || "./",
    plugins: [react()],
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        "/api": "http://127.0.0.1:8787",
      },
    },
    build: {
      outDir: resolve(projectRoot, "web-dist"),
      emptyOutDir: true,
    },
  };
});
