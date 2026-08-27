import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const overlayDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  base: "./",
  resolve: {
    alias: {
      "@poe2tc/core/operator": path.resolve(overlayDir, "../../packages/core/src/operator/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(overlayDir, "index.html"),
        banner: path.resolve(overlayDir, "banner.html"),
        worker: path.resolve(overlayDir, "worker.html"),
      },
    },
  },
});
