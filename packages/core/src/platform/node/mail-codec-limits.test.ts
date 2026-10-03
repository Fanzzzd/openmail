import { beforeEach, expect, it, vi } from "vitest";
import { PermanentError } from "../../errors.js";
import type { MailCodecPort } from "../mail-codec.js";
import { makeNodeMailCodec } from "./mail-codec.js";

const parser = vi.fn<MailCodecPort["parse"]>();
const nodeMailCodec = makeNodeMailCodec(parser);
beforeEach(() => parser.mockReset());

it("desktop MIME accepts raw input above the mobile cap and up to 64 MiB", async () => {
  const parsed = { attachments: [], headers: new Map(), html: false } satisfies Awaited<
    ReturnType<MailCodecPort["parse"]>
  >;
  parser.mockResolvedValueOnce(parsed);
  expect(await nodeMailCodec.parse(new Uint8Array(32 * 1024 * 1024))).toBe(parsed);
  parser.mockResolvedValueOnce(parsed);
  expect(await nodeMailCodec.parse(new Uint8Array(64 * 1024 * 1024))).toBe(parsed);
});

it("desktop MIME rejects above 64 MiB before calling the parser", async () => {
  parser.mockClear();
  await expect(nodeMailCodec.parse(new Uint8Array(64 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(
    PermanentError,
  );
  expect(parser).not.toHaveBeenCalled();
});

it("desktop MIME preserves the original parser failure as a non-enumerable cause", async () => {
  const cause = new Error("Malformed MIME at parser boundary");
  parser.mockRejectedValueOnce(cause);
  try {
    await nodeMailCodec.parse(new Uint8Array());
    throw new Error("Expected a parse rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PermanentError);
    expect(error instanceof Error && error.cause).toBe(cause);
    expect(JSON.stringify(error)).not.toContain(cause.message);
  }
});
