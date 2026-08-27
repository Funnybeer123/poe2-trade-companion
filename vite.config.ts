import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import electron from "vite-plugin-electron/simple";
import path from "node:path";

const buildMode = process.env.POE2_BUILD_MODE ?? "public-companion";

export default defineConfig({
  server: {
    watch: {
      ignored: ["**/artifacts/**", "**/release/**"],
    },
  },
  define: {
    __POE2_BUILD_MODE__: JSON.stringify(buildMode),
  },
  resolve: {
    alias: {
      "@core": path.resolve(__dirname, "src/core"),
      "@adapters": path.resolve(__dirname, "src/adapters"),
    },
  },
  plugins: [
    vue(),
    electron({
      main: {
        entry: "src/main/index.ts",
        onstart({ startup }) {
          void startup(
            process.env.POE2_REMOTE_DEBUG === "1"
              ? [".", "--remote-debugging-port=9222"]
              : undefined,
          );
        },
        vite: {
          define: {
            __POE2_BUILD_MODE__: JSON.stringify(buildMode),
          },
          resolve: {
            alias: {
              "@core": path.resolve(__dirname, "src/core"),
              "@adapters": path.resolve(__dirname, "src/adapters"),
            },
          },
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              // Native Node modules must stay external so electron-builder can
              // rebuild and package their platform-specific binaries.
              external: ["better-sqlite3"],
            },
          },
        },
      },
      preload: {
        input: "src/main/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["better-sqlite3"],
            },
          },
        },
      },
    }),
  ],
});
