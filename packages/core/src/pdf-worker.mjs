import { parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

// Fail closed: this worker has no network work. PDF resources come from disk.
globalThis.fetch = () => Promise.reject(new Error("PDF worker network disabled"));
try {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const resources = import.meta.resolve("pdfjs-dist/package.json");
  const options = {
    data: new Uint8Array(workerData.data),
    standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", resources)),
    cMapUrl: fileURLToPath(new URL("cmaps/", resources)),
    cMapPacked: true,
    wasmUrl: fileURLToPath(new URL("wasm/", resources)),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    enableXfa: false,
  };
  const task = getDocument(options);
  try {
    const document = await task.promise;
    if (document.numPages > workerData.maxPages) throw new Error("PDF page limit exceeded");
    const pages = [];
    let total = 0;
    for (let page = 1; page <= document.numPages; page++) {
      const pdfPage = await document.getPage(page);
      const content = await pdfPage.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
        .trim();
      total += text.length;
      if (total > 1_000_000) throw new Error("PDF text limit exceeded");
      let png;
      if (workerData.renderPage === page) {
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.sqrt(4_000_000 / (base.width * base.height)));
        const viewport = pdfPage.getViewport({ scale });
        const surface = document.canvasFactory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        try {
          await pdfPage.render({ canvas: surface.canvas, viewport }).promise;
          png = surface.canvas.toBuffer("image/png").toString("base64");
        } finally {
          document.canvasFactory.destroy(surface);
        }
      }
      pages.push({ page, text, ...(png ? { png } : {}) });
    }
    parentPort.postMessage({ ok: true, pages }, []);
  } finally {
    await task.destroy();
  }
} catch {
  parentPort.postMessage({ ok: false }, []);
}
