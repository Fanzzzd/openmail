/** Synthetic scanned PDF. No mail, model downloads or app profile access. Node 24, macOS. */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Effect } from "effect";
import { pdfText } from "../../../packages/core/dist/platform/node/pdf-text.js";
import { desktopVision } from "../src/main/app/vision.ts";

if (process.platform === "darwin") {
  const require = createRequire(
    realpathSync(
      fileURLToPath(
        new URL("../../../packages/core/node_modules/pdfjs-dist/package.json", import.meta.url),
      ),
    ),
  );
  const { createCanvas } = require("@napi-rs/canvas");
  const canvas = createCanvas(600, 400);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 600, 400);
  ctx.fillStyle = "black";
  ctx.font = "36px sans-serif";
  ctx.fillText("BOARDING GATE B12", 30, 100);
  const rgba = ctx.getImageData(0, 0, 600, 400).data;
  const rgb = Buffer.alloc(600 * 400 * 3);
  for (let pixel = 0; pixel < 600 * 400; pixel++)
    for (let channel = 0; channel < 3; channel++)
      rgb[pixel * 3 + channel] = rgba[pixel * 4 + channel];
  const image = deflateSync(rgb);
  const command = Buffer.from("q 600 0 0 400 0 0 cm /Im0 Do Q");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${command.length} >>\nstream\n`),
      command,
      Buffer.from("\nendstream"),
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 600 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
      ),
      image,
      Buffer.from("\nendstream"),
    ]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    length += part.length;
  }
  const xref = length;
  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
    ),
  );
  const pages = await Effect.runPromise(pdfText(Buffer.concat(parts), { renderPage: 1 }));
  assert.equal(pages[0].text, "");
  assert.ok(pages[0].png);
  const vision = await desktopVision(
    fileURLToPath(new URL("../out/native/vision", import.meta.url)),
  );
  assert.equal(vision.available, true);
  const result = await Effect.runPromise(vision.recognize(Buffer.from(pages[0].png, "base64")));
  assert.ok(result.lines.some((line) => line.text.includes("BOARDING GATE B12")));
  assert.ok(
    result.lines.every(
      (line) =>
        line.region.box.x >= 0 &&
        line.region.box.y >= 0 &&
        line.region.box.x + line.region.box.width <= line.region.imageWidth &&
        line.region.box.y + line.region.box.height <= line.region.imageHeight,
    ),
  );
  process.stdout.write("Scanned PDF: local render, OCR and original page image regions passed\n");
}
