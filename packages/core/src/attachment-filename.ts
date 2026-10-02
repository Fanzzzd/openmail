/** Mail filenames are untrusted display text. Remove control/format characters,
 * cap UTF-8 bytes on code-point boundaries and preserve ordinary extensions. */
export function attachmentFilename(input: string): string {
  const name = input.replace(/[\p{Cc}\p{Cf}]/gu, "_");
  const encoder = new TextEncoder();
  const prefix = (value: string, budget: number) => {
    let out = "";
    for (const character of value) {
      const size = encoder.encode(character).length;
      if (size > budget) break;
      out += character;
      budget -= size;
    }
    return out;
  };
  if (encoder.encode(name).length <= 200) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? prefix(name.slice(dot), 64) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return prefix(stem, 200 - encoder.encode(extension).length) + extension;
}
