import { execFile } from "node:child_process";
import { nativeBinary } from "./native-binary";
import { app, type BrowserWindow } from "electron";
import { Effect, Schema } from "effect";
import { DeviceError, attachmentBytes } from "@openmail/core";
import {
  GrammarIssue,
  NativePicker,
  NativePickerLabels,
  NativePickerResult,
  validateGrammarIssues,
} from "../shared/native-compose";

const failed = () => new DeviceError({ message: "Native compose operation failed." });
type Helper = "photos" | "grammar";
const busy = new WeakMap<BrowserWindow, Set<Helper>>();
export function nativeComposeCapabilities(
  platform = process.platform,
  version = process.getSystemVersion(),
) {
  const available =
    platform === "darwin" &&
    /^(?:\d+)(?:\.\d+)*$/.test(version) &&
    Number(version.split(".")[0]) >= 13;
  return { photos: available, continuity: available, grammar: available };
}
/** Text goes over stdin, never process arguments, files, network or logs. */
function execute(parent: BrowserWindow | null, name: Helper, mode: string, input: string) {
  return new Promise<string>((resolve, reject) => {
    if (
      !nativeComposeCapabilities().photos ||
      !parent ||
      parent.isDestroyed() ||
      busy.get(parent)?.has(name)
    ) {
      reject(new Error("Native compose unavailable"));
      return;
    }
    const running = busy.get(parent) ?? new Set<Helper>();
    running.add(name);
    busy.set(parent, running);
    const executable = name === "photos" ? "OpenMailPhotos.app/Contents/MacOS/photos" : "grammar";
    const binary = nativeBinary(executable);
    const child = execFile(
      binary,
      [mode],
      { timeout: name === "photos" ? 300_000 : 30_000, maxBuffer: 44 * 1024 * 1024 },
      (error, output) => {
        running.delete(name);
        if (running.size === 0) busy.delete(parent);
        parent.removeListener("closed", closed);
        app.removeListener("will-quit", closed);
        if (name === "photos" && !parent.isDestroyed()) parent.focus();
        if (error) reject(new Error("Native compose failed"));
        else resolve(output);
      },
    );
    const closed = () => {
      child.kill();
    };
    parent.once("closed", closed);
    app.once("will-quit", closed);
    child.stdin?.on("error", () => {
      child.kill();
    });
    child.stdin?.end(input);
  });
}
export const pickNativeImages = (
  parent: BrowserWindow | null,
  kind: typeof NativePicker.Type,
  labels: typeof NativePickerLabels.Type,
) =>
  Effect.tryPromise({
    try: async () => {
      const output = await execute(parent, "photos", `--${kind}`, JSON.stringify(labels));
      return decodeNativeImages(output, kind);
    },
    catch: failed,
  });
export const checkNativeGrammar = (parent: BrowserWindow | null, text: string) =>
  Effect.tryPromise({
    try: async () => {
      const output = await execute(parent, "grammar", "--check", text);
      return validateGrammarIssues(
        text,
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(GrammarIssue)))(output),
      );
    },
    catch: failed,
  });

/** Validate the helper stdout boundary before the composer sees any bytes. */
export function decodeNativeImages(output: string, kind: NativePicker) {
  const result = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Union([NativePickerResult, Schema.Struct({ status: Schema.Literal("error") })]),
    ),
  )(output);
  if (result.status === "error") throw new Error("Native image import failed");
  const files = result.files;
  if (
    files.length > 16 ||
    files.length + result.skipped > 16 ||
    files.some(
      (file) =>
        !["image/jpeg", "application/pdf"].includes(file.mimeType) ||
        (kind === "photos" && file.mimeType !== "image/jpeg") ||
        file.contentId !== undefined ||
        file.sourceMessageId !== undefined ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content) ||
        !file.content,
    ) ||
    files.reduce((sum, file) => sum + attachmentBytes(file.content), 0) > 30 * 1024 * 1024
  )
    throw new Error("Invalid picker result");
  return result;
}
