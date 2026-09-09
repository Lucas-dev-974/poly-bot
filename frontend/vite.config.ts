import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

// Build output goes to ../dist/dashboard/public so the compiled backend
// (dist/dashboard/server.js) serves it via HTML_PATH (server.ts:10).
// Dev server proxies API + SSE to the backend on port 3105.
export default defineConfig({
  plugins: [solid()],
  base: "/",
  build: {
    outDir: fileURLToPath(new URL("../dist/dashboard/public", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    fs: {
      allow: [".."],
    },
    proxy: {
      "/api": "http://127.0.0.1:3105",
      "/events": "http://127.0.0.1:3105",
    },
  },
});
