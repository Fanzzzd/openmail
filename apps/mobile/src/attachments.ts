import { File, Paths } from "expo-file-system";
import { getDocumentAsync } from "expo-document-picker";
import { launchImageLibraryAsync } from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import {
  attachmentBytes,
  mobileAttachmentProblem,
  MOBILE_ATTACHMENT_LIMIT,
  type Provider,
  type OutgoingAttachment,
} from "@openmail/core/portable";

function removeTemp(uri: string) {
  // Picker copies and re-encoded images belong to cache, never delete a library original.
  const root = new URL(Paths.cache.uri);
  const url = new URL(uri);
  if (url.protocol === "file:" && url.pathname.startsWith(`${root.pathname.replace(/\/$/, "")}/`))
    new File(uri).delete();
}
function removePickerTemps(temporary: ReadonlySet<string>) {
  let failed = false;
  for (const uri of temporary)
    try {
      removeTemp(uri);
    } catch {
      failed = true;
    }
  if (failed) throw new Error("Could not remove attachment temporary files");
}
export async function pickAttachments(
  source: "document" | "photo",
  existing: readonly OutgoingAttachment[] = [],
  provider: Provider = "gmail",
): Promise<OutgoingAttachment[]> {
  const assets =
    source === "document"
      ? await getDocumentAsync({ copyToCacheDirectory: true, multiple: true }).then((result) =>
          result.canceled
            ? []
            : result.assets.map((asset) => ({
                uri: asset.uri,
                name: asset.name,
                mimeType: asset.mimeType,
              })),
        )
      : await launchImageLibraryAsync({
          mediaTypes: ["images"],
          allowsMultipleSelection: true,
          quality: 1,
          exif: false,
        }).then((result) =>
          result.canceled
            ? []
            : result.assets.map((asset) => ({
                uri: asset.uri,
                name: asset.fileName ?? "photo.jpg",
                mimeType: asset.mimeType,
              })),
        );
  const temporary = new Set(assets.map((asset) => asset.uri));
  const attachments: OutgoingAttachment[] = [];
  try {
    const existingBytes = existing.reduce((sum, file) => sum + attachmentBytes(file.content), 0);
    if (
      existingBytes + assets.reduce((sum, asset) => sum + new File(asset.uri).size, 0) >
      MOBILE_ATTACHMENT_LIMIT
    )
      throw new Error("Attachments exceed mobile size limit");
    for (const asset of assets) {
      let file = new File(asset.uri);
      let filename = asset.name;
      let mimeType = asset.mimeType ?? "application/octet-stream";
      if (source === "photo") {
        // Decoding pixels and saving a fresh image discards source EXIF/GPS. exif:false
        // alone only hides metadata from the picker result and does not strip file bytes.
        const context = ImageManipulator.manipulate(asset.uri);
        let image: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
        try {
          image = await context.renderAsync();
          const png = mimeType === "image/png";
          const output = await image.saveAsync({
            format: png ? SaveFormat.PNG : SaveFormat.JPEG,
            compress: 1,
          });
          temporary.add(output.uri);
          file = new File(output.uri);
          filename = `${filename.replace(/\.[^.]*$/, "")}.${png ? "png" : "jpg"}`;
          mimeType = png ? "image/png" : "image/jpeg";
        } finally {
          image?.release();
          context.release();
        }
      }
      const bytes =
        existingBytes +
        attachments.reduce((sum, attachment) => sum + attachmentBytes(attachment.content), 0) +
        file.size;
      if (bytes > MOBILE_ATTACHMENT_LIMIT) throw new Error("Attachments exceed mobile size limit");
      attachments.push({ filename, mimeType, content: await file.base64() });
      if (mobileAttachmentProblem(provider, [...existing, ...attachments]))
        throw new Error("Attachments rejected before sending");
    }
    return attachments;
  } finally {
    removePickerTemps(temporary);
  }
}
