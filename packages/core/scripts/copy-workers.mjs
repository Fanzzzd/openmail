import { copyFileSync } from "node:fs";
copyFileSync(
  new URL("../src/pdf-worker.mjs", import.meta.url),
  new URL("../dist/pdf-worker.mjs", import.meta.url),
);
