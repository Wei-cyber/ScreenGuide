import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Packaged Electron pages load over file://, so every emitted asset URL must
  // remain relative to its HTML file instead of resolving from filesystem root.
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        control: resolve(projectRoot, "index.html"),
        overlay: resolve(projectRoot, "overlay.html"),
      },
    },
  },
});
