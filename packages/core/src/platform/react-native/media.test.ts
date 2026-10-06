import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { PdfWorker, ImageNetwork } from "../runtime.js";
import { mobileMediaLayer } from "./media.js";

it("reports unavailable PDF extraction for every request without network fallback", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const pdf = yield* PdfWorker;
        const result = yield* pdf
          .extract(new Uint8Array([37, 80, 68, 70]), { renderPage: 1 })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.message).toContain("unavailable on mobile");
      }).pipe(Effect.provide(mobileMediaLayer)),
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it("refuses compose URL imports including public, loopback and redirected addresses without fetch", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const images = yield* ImageNetwork;
        for (const url of [
          "https://example.com/image.png",
          "http://127.0.0.1/image.png",
          "https://example.com/redirect",
        ]) {
          const result = yield* images.download(url, 256 * 1024).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.message).toContain("unavailable on mobile");
        }
      }).pipe(Effect.provide(mobileMediaLayer)),
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
