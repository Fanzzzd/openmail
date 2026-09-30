import { lingui } from "@lingui/vite-plugin";
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
        "@base-ui/react/checkbox",
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
});
