import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import { deviceErrorReason } from "./device-errors.js";
import { DeviceError, MailError } from "./errors.js";

it("local failures carry short reasons through RPC, without an action prefix", () => {
  for (const reason of ["No printers available on the network", "No printers are available."]) {
    const failure = new DeviceError({ message: deviceErrorReason(reason) });
    const codec = Schema.toCodecJson(MailError);
    const received = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(failure));
    assert.strictEqual(received._tag, "DeviceError");
    assert.strictEqual(received.message, "no printers are available.");
    assert.strictEqual(
      `Couldn't print: ${received.message}`,
      "Couldn't print: no printers are available.",
    );
  }
  assert.strictEqual(deviceErrorReason(new Error("permission denied")), "permission denied");
  assert.strictEqual(deviceErrorReason(""), "the operation failed.");
});
