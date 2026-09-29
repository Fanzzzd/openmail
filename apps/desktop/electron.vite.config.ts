import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import Icons from "unplugin-icons/vite";

export default defineConfig({
  // `@openmail/core` and its keychain binding stay external: the main process
  // imports them from node_modules at runtime.
  main: {},
  preload: {
    // Sandboxed preloads cannot be ES modules.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    plugins: [
      react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
      tailwindcss(),
      // Brand marks come from Iconify icon packages and compile into the
      // bundle, so the app never fetches icons at runtime.
      Icons({ compiler: "jsx", jsx: "react" }),
    ],
  },
});
