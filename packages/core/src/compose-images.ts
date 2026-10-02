import { Effect } from "effect";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { OutgoingAttachment } from "./domain.js";
import { InvalidInput, ProviderError } from "./errors.js";

export const COMPOSE_IMAGE_LIMIT = 8 * 1024 * 1024;
export const CONTACT_PHOTO_LIMIT = 256 * 1024;

/** Only passive raster formats; a declared MIME type alone cannot admit HTML/SVG. */
export function rasterMime(bytes: Uint8Array): string | undefined {
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  const head = new TextDecoder().decode(bytes.subarray(0, 12));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export function imageAttachment(
  file: Pick<OutgoingAttachment, "filename" | "content" | "mimeType">,
) {
  return Effect.try({
    try: () => {
      if (
        file.content.length > Math.ceil(COMPOSE_IMAGE_LIMIT / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)
      )
        throw new Error();
      const bytes = Buffer.from(file.content, "base64");
      const mimeType = rasterMime(bytes);
      if (
        !mimeType ||
        bytes.length > COMPOSE_IMAGE_LIMIT ||
        file.mimeType.toLowerCase() !== mimeType
      )
        throw new Error();
      return {
        filename: file.filename,
        content: bytes.toString("base64"),
        mimeType,
        contentId: `image-${randomUUID()}@openmail`,
      } satisfies OutgoingAttachment;
    },
    catch: () => new InvalidInput({ message: "Use a PNG, JPEG, GIF or WebP image up to 8 MB" }),
  });
}

export function publicImageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // IPv6 global unicast only; mapped IPv4, local, multicast and documentation are excluded.
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^2001:(db8|0):/i.test(address) &&
    !address.startsWith("2002:")
  );
}

export type DownloadedImage = { mimeType: string; content: string };
export type ImageDownloader = (
  url: string,
  limit: number,
) => Effect.Effect<DownloadedImage, InvalidInput | ProviderError>;

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

/** Stream cap is enforced before retaining each chunk, including chunked HTTP without Content-Length. */
export async function readRasterImage(
  stream: AsyncIterable<Uint8Array>,
  declared: string,
  limit: number,
): Promise<DownloadedImage> {
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(declared))
    throw new Error("Image response has an invalid type");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("Image exceeds the size limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const mimeType = rasterMime(bytes);
  if (mimeType !== declared) throw new Error("Image content does not match its type");
  return { mimeType, content: bytes.toString("base64") };
}
