import { copyFileSync } from "node:fs";
copyFileSync(
  new URL("../src/pdf-worker.mjs", import.meta.url),
  new URL("../dist/pdf-worker.mjs", import.meta.url),
);

copyFileSync(
  new URL("../src/embedding-worker.mjs", import.meta.url),
  new URL("../dist/embedding-worker.mjs", import.meta.url),
);

copyFileSync(
  new URL("../src/resettable-loader.mjs", import.meta.url),
  new URL("../dist/resettable-loader.mjs", import.meta.url),
);
