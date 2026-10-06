import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  size: 3,
  base64: vi.fn(),
  removed: vi.fn(),
  document: vi.fn(),
  photo: vi.fn(),
  manipulate: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
  release: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache/" } },
  File: class {
    uri: string;
    size = native.size;
    constructor(uri: string) {
      this.uri = uri;
    }
    base64() {
      return native.base64(this.uri);
    }
    delete() {
      native.removed(this.uri);
    }
  },
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: native.document }));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: native.photo }));
vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { PNG: "png", JPEG: "jpeg" },
  ImageManipulator: { manipulate: native.manipulate },
}));
import { pickAttachments } from "./attachments";
beforeEach(() => {
  vi.clearAllMocks();
  native.size = 3;
  native.base64.mockImplementation(async (uri: string) =>
    uri.endsWith("clean.jpg") ? "AQID" : "R1BT",
  );
  native.document.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///cache/report.txt", name: "report.txt", mimeType: "text/plain" }],
  });
  native.photo.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///cache/photo.heic", fileName: "photo.heic", mimeType: "image/heic" }],
  });
  native.save.mockResolvedValue({ uri: "file:///cache/clean.jpg" });
  native.render.mockResolvedValue({ saveAsync: native.save, release: native.release });
  native.manipulate.mockReturnValue({ renderAsync: native.render, release: native.release });
});
it("reads a cached document and deletes its temporary copy", async () => {
  expect(await pickAttachments("document")).toEqual([
    { filename: "report.txt", mimeType: "text/plain", content: "R1BT" },
  ]);
  expect(native.document).toHaveBeenCalledWith({ copyToCacheDirectory: true, multiple: true });
  expect(native.removed).toHaveBeenCalledWith("file:///cache/report.txt");
});
it("re-encodes pixels before attaching photos, never reading the GPS-bearing original", async () => {
  expect(await pickAttachments("photo")).toEqual([
    { filename: "photo.jpg", mimeType: "image/jpeg", content: "AQID" },
  ]);
  expect(native.manipulate).toHaveBeenCalledWith("file:///cache/photo.heic");
  expect(native.save).toHaveBeenCalledWith({ format: "jpeg", compress: 1 });
  expect(native.base64).toHaveBeenCalledExactlyOnceWith("file:///cache/clean.jpg");
  expect(native.removed.mock.calls).toEqual([
    ["file:///cache/photo.heic"],
    ["file:///cache/clean.jpg"],
  ]);
  expect(native.release).toHaveBeenCalledTimes(2);
});
it("keeps PNG transparency by re-encoding as PNG", async () => {
  native.photo.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///cache/image.png", fileName: "image.png", mimeType: "image/png" }],
  });
  await pickAttachments("photo");
  expect(native.save).toHaveBeenCalledWith({ format: "png", compress: 1 });
});
it("handles cancellation without allocating or deleting files", async () => {
  native.photo.mockResolvedValue({ canceled: true });
  expect(await pickAttachments("photo")).toEqual([]);
  expect(native.manipulate).not.toHaveBeenCalled();
  expect(native.removed).not.toHaveBeenCalled();
});
it("cleans every picker copy even when re-encoding or reading fails", async () => {
  native.photo.mockResolvedValue({
    canceled: false,
    assets: [
      { uri: "file:///cache/a.jpg", fileName: "a.jpg" },
      { uri: "file:///cache/b.jpg", fileName: "b.jpg" },
    ],
  });
  native.render.mockRejectedValueOnce(new Error("decode failed"));
  await expect(pickAttachments("photo")).rejects.toThrow("decode failed");
  expect(native.removed.mock.calls).toEqual([["file:///cache/a.jpg"], ["file:///cache/b.jpg"]]);
  native.base64.mockRejectedValueOnce(new Error("read failed"));
  await expect(pickAttachments("document")).rejects.toThrow("read failed");
  expect(native.removed).toHaveBeenCalledWith("file:///cache/report.txt");
});
it("checks cumulative limits and shared Outlook policy before queueing", async () => {
  native.size = 16 * 1024 * 1024;
  await expect(pickAttachments("document")).rejects.toThrow("size limit");
  expect(native.base64).not.toHaveBeenCalled();
  expect(native.removed).toHaveBeenCalled();
  native.size = 3;
  const existing = [
    { filename: "old.eml", mimeType: "message/rfc822", content: "AAAA".repeat(1024 * 1024 + 1) },
  ];
  await expect(pickAttachments("document", existing, "outlook")).rejects.toThrow(
    "rejected before sending",
  );
});
it("never deletes a library original outside its own cache", async () => {
  native.photo.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///library/original.heic", fileName: "original.heic" }],
  });
  await pickAttachments("photo");
  expect(native.removed).not.toHaveBeenCalledWith("file:///library/original.heic");
  expect(native.removed).toHaveBeenCalledWith("file:///cache/clean.jpg");
});
