import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

/**
 * The renderer's web build, for remote access from the person's own devices.
 * The Mac serves out/web over its tailnet; see src/main/remote. Same app as the
 * desktop window, with a WebSocket RPC transport and browser history, so
 * assets use absolute paths.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "/",
  // The manifest and home-screen icons, copied to out/web as they are.
  publicDir: resolve(import.meta.dirname, "src/renderer/web-public"),
  plugins: [
    react({
      babel: { plugins: ["@lingui/babel-plugin-lingui-macro", "babel-plugin-react-compiler"] },
    }),
    lingui(),
    tailwindcss(),
    Icons({ compiler: "jsx", jsx: "react" }),
  ],
  build: {
    outDir: resolve(import.meta.dirname, "out/web"),
    emptyOutDir: true,
    // The app entry is the same size as in the desktop window.
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      input: { web: resolve(import.meta.dirname, "src/renderer/web.html") },
      output: {
        manualChunks: (id) =>
          id.includes("/node_modules/@tanstack/")
            ? "router"
            : /\/node_modules\/(react|react-dom|scheduler)\/|commonjsHelpers/.test(id)
              ? "react"
              : undefined,
      },
    },
  },
});
