import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Effect } from "effect";
import { ProviderError } from "../../domain/errors.js";
import { publicImageAddress, readRasterImage } from "../../compose/compose-images.js";
import type { DownloadedImage, ImageDownloader } from "../runtime.js";
/** DNS is resolved once and pinned for the request. Every redirect repeats validation. */
export const downloadRemoteImage: ImageDownloader = (input, limit) =>
  Effect.tryPromise({
    try: async (signal) => {
      let url = new URL(input);
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (
          !/^https?:$/.test(url.protocol) ||
          url.username ||
          url.password ||
          (url.port && !["80", "443"].includes(url.port))
        )
          throw new Error("Use a public http or https image URL");
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = await lookup(hostname, { all: true });
        const first = addresses[0];
        if (!first || addresses.some((item) => !publicImageAddress(item.address)))
          throw new Error("Use a public image URL");
        const result = await new Promise<{ redirect: string } | DownloadedImage>(
          (resolve, reject) => {
            const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
              url,
              {
                hostname: first.address,
                servername: hostname,
                signal,
                headers: { Host: url.host, Accept: "image/png,image/jpeg,image/gif,image/webp" },
              },
              (response) => {
                const status = response.statusCode ?? 0;
                if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                  response.destroy();
                  resolve({ redirect: response.headers.location });
                  return;
                }
                const declared = response.headers["content-type"]
                  ?.split(";")[0]
                  ?.trim()
                  .toLowerCase();
                if (
                  status !== 200 ||
                  !declared ||
                  !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(declared) ||
                  Number(response.headers["content-length"] ?? 0) > limit
                ) {
                  response.destroy();
                  reject(new Error("Image response has an invalid type or size"));
                  return;
                }
                void readRasterImage(response, declared, limit).then(resolve, reject);
              },
            );
            const timer = setTimeout(
              () => request.destroy(new Error("Image download timed out")),
              15000,
            );
            request.on("close", () => clearTimeout(timer));
            request.on("error", reject);
            request.end();
          },
        );
        if ("redirect" in result) url = new URL(result.redirect, url);
        else return result;
      }
      throw new Error("Image redirected too many times");
    },
    catch: (error) =>
      new ProviderError({
        message: error instanceof Error ? error.message : "Image download failed",
      }),
  });
