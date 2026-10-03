import type { Label } from "@openmail/core/portable";

/** Parent folders precede children. Missing parent folders keep a readable full path. */
export function mailboxTree(labels: readonly Label[]) {
  const names = new Set(labels.map((label) => label.name));
  return [...labels]
    .sort((a, b) => {
      const left = a.name.split("/");
      const right = b.name.split("/");
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const order = (left[i] ?? "").localeCompare(right[i] ?? "");
        if (order) return order;
      }
      return left.length - right.length || a.id.localeCompare(b.id);
    })
    .map((label) => {
      const parts = label.name.split("/");
      let depth = 0;
      let prefix = "";
      for (const part of parts.slice(0, -1)) {
        prefix = prefix ? `${prefix}/${part}` : part;
        if (names.has(prefix)) depth++;
      }
      return { label, depth, name: depth ? (parts.at(-1) ?? label.name) : label.name };
    });
}
