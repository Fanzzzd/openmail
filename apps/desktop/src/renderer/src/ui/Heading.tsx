import { createContext, type HTMLAttributes, useContext } from "react";

const TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * How many levels the headings below move. The reader's subject is the h1 when the reader has
 * the window and an h2 beside the list, and the message headings under it follow it.
 */
export const HeadingShift = createContext(0);

/** A heading at `level` under a subject h2, moved by the enclosing HeadingShift. */
export function Heading({
  level,
  ...props
}: { level: 2 | 3 | 4 } & HTMLAttributes<HTMLHeadingElement>) {
  const Tag = TAGS[Math.min(5, Math.max(0, level + useContext(HeadingShift) - 1))] ?? "h2";
  return <Tag {...props} />;
}
