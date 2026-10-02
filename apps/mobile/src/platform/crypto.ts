import { PlatformCrypto, sha256Hex, hmacSha256Hex } from "@openmail/core/portable";
import { Crypto, Effect, Layer, PlatformError } from "effect";
import * as ExpoCrypto from "expo-crypto";

const algorithms = {
  "SHA-1": ExpoCrypto.CryptoDigestAlgorithm.SHA1,
  "SHA-256": ExpoCrypto.CryptoDigestAlgorithm.SHA256,
  "SHA-384": ExpoCrypto.CryptoDigestAlgorithm.SHA384,
  "SHA-512": ExpoCrypto.CryptoDigestAlgorithm.SHA512,
};
export const cryptoLayer = Layer.mergeAll(
  Layer.succeed(PlatformCrypto, {
    randomUUID: ExpoCrypto.randomUUID,
    sha256: sha256Hex,
    hmac: hmacSha256Hex,
  }),
  Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: ExpoCrypto.getRandomBytes,
      digest: (algorithm, data) =>
        Effect.tryPromise({
          try: async () =>
            new Uint8Array(await ExpoCrypto.digest(algorithms[algorithm], new Uint8Array(data))),
          catch: () =>
            PlatformError.systemError({ _tag: "Unknown", module: "Crypto", method: "digest" }),
        }),
    }),
  ),
);
