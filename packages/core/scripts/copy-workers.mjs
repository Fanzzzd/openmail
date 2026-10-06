import { copyFileSync } from "node:fs";
copyFileSync(
  new URL("../src/platform/node/pdf-worker.mjs", import.meta.url),
  new URL("../dist/platform/node/pdf-worker.mjs", import.meta.url),
);

copyFileSync(
  new URL("../src/platform/node/embedding-worker.mjs", import.meta.url),
  new URL("../dist/platform/node/embedding-worker.mjs", import.meta.url),
);

copyFileSync(
  new URL("../src/platform/node/resettable-loader.mjs", import.meta.url),
  new URL("../dist/platform/node/resettable-loader.mjs", import.meta.url),
);

copyFileSync(
  new URL("../src/platform/node/cache-worker.mjs", import.meta.url),
  new URL("../dist/platform/node/cache-worker.mjs", import.meta.url),
);
