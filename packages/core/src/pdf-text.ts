import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { MediaError } from "./media.js";

/** Text only. No remote resources, JavaScript evaluation, or embedded actions. */
export const pdfText = (data: Uint8Array) =>
  Effect.tryPromise({
    try: async (signal) => {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const resources = import.meta.resolve("pdfjs-dist/package.json");
      const task = getDocument({
        standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", resources)),
        cMapUrl: fileURLToPath(new URL("cmaps/", resources)),
        cMapPacked: true,
        wasmUrl: fileURLToPath(new URL("wasm/", resources)),
        data: new Uint8Array(data),
        useSystemFonts: false,
        disableFontFace: true,
        useWorkerFetch: false,
        enableXfa: false,
      });
      const cancel = () => {
        void task.destroy();
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const document = await task.promise;
        const pages: { page: number; text: string }[] = [];
        for (let page = 1; page <= document.numPages; page++) {
          const content = await (await document.getPage(page)).getTextContent();
          pages.push({
            page,
            text: content.items
              .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
              .join("")
              .trim(),
          });
        }
        return pages;
      } finally {
        signal.removeEventListener("abort", cancel);
        await task.destroy();
      }
    },
    catch: () => new MediaError({ message: "Cannot extract PDF text" }),
  });
