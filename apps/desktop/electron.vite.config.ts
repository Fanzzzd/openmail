import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import Icons from "unplugin-icons/vite";

import { describeBuiltInClients, readBuiltInClients } from "./oauth-clients";

const builtInClients = readBuiltInClients();

export default defineConfig(({ command }) => {
  if (command === "build") process.stdout.write(`${describeBuiltInClients(builtInClients)}\n`);
  return {
    // `@openmail/core` and its keychain binding stay external: the main process
    // imports them from node_modules at runtime.
    main: {
      plugins: [react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }), lingui()],
      // openmail's own OAuth clients, from env vars or the gitignored local file.
      // Main only: the renderer and preload never see the values.
      define: { __OPENMAIL_OAUTH_CLIENTS__: JSON.stringify(builtInClients.clients) },
    },
    preload: {
      // Sandboxed preloads cannot be ES modules. The recovery window has its own preload.
      build: {
        rollupOptions: {
          input: {
            index: resolve(import.meta.dirname, "src/preload/index.ts"),
            recovery: resolve(import.meta.dirname, "src/preload/recovery.ts"),
          },
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      // recovery.html is the crash/database recovery prompt, loaded before the app starts.
      build: {
        rollupOptions: {
          input: {
            index: resolve(import.meta.dirname, "src/renderer/index.html"),
            recovery: resolve(import.meta.dirname, "src/renderer/recovery.html"),
          },
          output: {
            // The router is its own vendor chunk, so its size shows apart from the app's entry.
            // A manual chunk takes in dependencies no other chunk claims, so React and Rollup's
            // CommonJS helpers get a chunk of their own; otherwise the recovery window, which
            // shares React with the app, would load the router too.
            manualChunks: (id) =>
              id.includes("/node_modules/@tanstack/")
                ? "router"
                : /\/node_modules\/(react|react-dom|scheduler)\/|commonjsHelpers/.test(id)
                  ? "react"
                  : undefined,
          },
        },
      },
      plugins: [
        {
          name: "openmail-development-csp",
          apply: "serve",
          transformIndexHtml: (html) =>
            html
              .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
              .replace(
                "connect-src 'none'",
                "connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
              ),
        },
        // The Lingui macro must run before the React Compiler, so the compiler
        // sees the plain `i18n._` calls the macros turn into.
        react({
          babel: {
            plugins: ["@lingui/babel-plugin-lingui-macro", "babel-plugin-react-compiler"],
          },
        }),
        lingui(),
        tailwindcss(),
        // Brand marks come from Iconify icon packages and compile into the
        // bundle, so the app never fetches icons at runtime.
        Icons({ compiler: "jsx", jsx: "react" }),
      ],
      // Base UI is imported by subpath. Pre-bundling them at startup keeps Vite
      // from optimizing one mid-session, which loads a second copy of React
      // and breaks hooks until a restart. Add new subpaths here.
      optimizeDeps: {
        include: [
          "@base-ui/react/alert-dialog",
          "@base-ui/react/autocomplete",
          "@base-ui/react/button",
          "@base-ui/react/checkbox",
          "@base-ui/react/input",
          "@base-ui/react/combobox",
          "@base-ui/react/context-menu",
          "@base-ui/react/dialog",
          "@base-ui/react/menu",
          "@base-ui/react/popover",
          "@base-ui/react/radio",
          "@base-ui/react/radio-group",
          "@base-ui/react/select",
          "@base-ui/react/tabs",
          "@base-ui/react/switch",
          "@base-ui/react/toggle",
          "@base-ui/react/toolbar",
          "@base-ui/react/tooltip",
          "react-resizable-panels",
        ],
      },
    },
  };
});
