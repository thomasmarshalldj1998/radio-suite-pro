import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

/**
 * Desktop (Electron) renderer build.
 *
 * Same app as the web build, but compiled as the standalone package:
 * - VITE_APP_MODE=desktop flips src/lib/backend to the device-local binding
 *   (presets, log, mount and session persist on-device; no sign-in gate),
 * - VITE_CONVEX_URL is pinned empty so no cloud client is ever constructed,
 * - the Freebuff preview toolbar is compiled out via IS_DESKTOP,
 * - output lands in dist-desktop/ for electron-builder.
 *
 * Deliberately independent from vite.config.ts (which serves the Freebuff
 * web runtime) so neither build's HMR/dev-server settings can affect the
 * other.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
  },
  define: {
    "import.meta.env.VITE_APP_MODE": JSON.stringify("desktop"),
    "import.meta.env.VITE_CONVEX_URL": JSON.stringify(""),
  },
  build: {
    outDir: "dist-desktop",
    sourcemap: false,
    target: "esnext",
    minify: "esbuild",
    chunkSizeWarningLimit: 1000,
  },
});
