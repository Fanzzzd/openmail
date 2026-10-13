import { Buffer } from "./platform/bytes.js";
import { Effect } from "effect";
import { ImageNetwork } from "./platform/runtime.js";
import { PlatformCrypto } from "./platform/crypto.js";
import { isIP } from "./platform/ip.js";
import type { OutgoingAttachment } from "./domain/domain.js";
import { InvalidInput, ProviderError } from "./domain/errors.js";

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
  return Effect.flatMap(PlatformCrypto, (crypto) =>
    Effect.try({
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
          contentId: `image-${crypto.randomUUID()}@openmail`,
        } satisfies OutgoingAttachment;
      },
      catch: () => new InvalidInput({ message: "Use a PNG, JPEG, GIF or WebP image up to 8 MB" }),
    }),
  );
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

export const downloadRemoteImage = (url: string, limit: number) =>
  Effect.flatMap(ImageNetwork, (network) => network.download(url, limit));

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
