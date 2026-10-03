import {
  escapeComposeText,
  richComposeBody,
  type MobileComposeMark,
} from "@openmail/core/portable";
export type Mark = MobileComposeMark;
export function markSelection(
  text: string,
  marks: readonly Mark[],
  selection: { start: number; end: number },
  kind: Mark["kind"],
): Mark[] {
  const start = selection.start === selection.end ? 0 : selection.start;
  const end = selection.start === selection.end ? text.length : selection.end;
  if (start === end) return [...marks];
  const existing = marks.some(
    (mark) => mark.kind === kind && mark.start === start && mark.end === end,
  );
  return existing
    ? marks.filter((mark) => !(mark.kind === kind && mark.start === start && mark.end === end))
    : [...marks, { start, end, kind }];
}
export function editMarks(previous: string, next: string, marks: readonly Mark[]): Mark[] {
  let prefix = 0;
  while (prefix < Math.min(previous.length, next.length) && previous[prefix] === next[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(previous.length, next.length) - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const removedEnd = previous.length - suffix;
  const delta = next.length - previous.length;
  return marks.flatMap((mark) => {
    if (mark.end <= prefix) return [mark];
    if (mark.start >= removedEnd)
      return [{ ...mark, start: mark.start + delta, end: mark.end + delta }];
    const start = Math.min(mark.start, prefix);
    const end = Math.max(prefix + next.length - prefix - suffix, mark.end + delta);
    return end > start ? [{ ...mark, start, end }] : [];
  });
}
export function richTextSegments(text: string, marks: readonly Mark[]) {
  const points = [
    ...new Set([0, text.length, ...marks.flatMap((mark) => [mark.start, mark.end])]),
  ].sort((a, b) => a - b);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1] ?? text.length;
    const has = (kind: Mark["kind"]) =>
      marks.some((mark) => mark.kind === kind && mark.start <= start && mark.end >= end);
    return { start, text: text.slice(start, end), bold: has("bold"), italic: has("italic") };
  });
}
export function richTextBody(
  text: string,
  marks: readonly Mark[],
  list: boolean,
): { text: string; html?: string } {
  if (!marks.length && !list) return { text };
  let offset = 0;
  const lines = text.split("\n").map((line) => {
    const lineMarks = marks
      .filter((mark) => mark.start < offset + line.length && mark.end > offset)
      .map((mark) => ({
        ...mark,
        start: Math.max(0, mark.start - offset),
        end: Math.min(line.length, mark.end - offset),
      }));
    offset += line.length + 1;
    return richTextSegments(line, lineMarks)
      .map((segment) => {
        let value = escapeComposeText(segment.text);
        if (segment.bold) value = `<strong>${value}</strong>`;
        if (segment.italic) value = `<em>${value}</em>`;
        return value;
      })
      .join("");
  });
  const html = list
    ? `<ul>${lines.map((line) => `<li>${line}</li>`).join("")}</ul>`
    : lines.join("<br>");
  return { text, html: richComposeBody(html).html };
}
