import { Buffer as PortableBuffer } from "buffer/index.js";

export type ByteEncoding = "utf8" | "utf-8" | "base64" | "hex" | "latin1" | "utf16le";
export interface ByteBuffer extends Uint8Array {
  toString(encoding?: ByteEncoding): string;
}
export interface ByteCodec {
  from(value: string, encoding?: ByteEncoding): ByteBuffer;
  from(value: Uint8Array | readonly number[]): ByteBuffer;
  byteLength(value: string | Uint8Array, encoding?: ByteEncoding): number;
  concat(values: readonly Uint8Array[], length?: number): ByteBuffer;
}

/** The only native-global probe in portable core. React Native uses the browser implementation. */
const nativeBuffer = globalThis.Buffer;
export const selectByteCodec = (native?: ByteCodec): ByteCodec => native ?? PortableBuffer;
export const Buffer: ByteCodec = selectByteCodec(nativeBuffer);
