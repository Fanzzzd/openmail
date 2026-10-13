import { readFileSync } from "node:fs";

const newsletter = readFileSync(
  new URL("../../../../test-support/fixtures/reader/mailchimp-newsletter.html", import.meta.url),
  "utf8",
);
const words = [
  "invoice",
  "delivery",
  "预算",
  "会议",
  "renewal",
  "Zürich",
  "&amp;",
  "&nbsp;",
  "offer",
];

/**
 * Newsletter-shaped HTML like the real mailbox behind the slice 97 profile (median
 * 22 KB, p90 89 KB, max 390 KB): a style sheet with media queries and hidden classes,
 * a hidden preheader, nested layout tables with inline colours, words unique to `n`.
 * Sizes run 3 to 25 KB (median 14 KB), with every 97th message near 105 KB.
 */
export function syncHtml(n: number): string {
  const rows = n % 97 ? 5 + ((n * 37) % 60) : 300;
  const row = (r: number) =>
    `<tr><td class="${r % 7 ? "col" : "desktop"}" style="padding:8px;color:#${((r * 2731) % 0xffffff).toString(16).padStart(6, "0")};background:#ffffff"><table role="presentation" width="100%"><tr><td>` +
    `<a href="https://news.example.test/${n}/${r}">${words[r % words.length]} m${n}r${r}</a> ` +
    `<span style="font-size:${r % 11 ? 14 : 1}px">${words[(r + n) % words.length]} item ${r}</span>` +
    `</td><td align="right"><img src="https://img.example.test/${r}.png" alt="">` +
    `${r % 13 ? "" : '<div style="display:none">hidden tracking</div>'}</td></tr></table></td></tr>`;
  return newsletter
    .replace(
      "</style>",
      `.col{font-family:Arial}.hide{display:none!important}@media (max-width:600px){.desktop{display:none}.col{width:100%!important}}${Array.from({ length: 30 }, (_, i) => `.c${i}{color:#${i}${i}${i}}`).join("")}</style>`,
    )
    .replace(
      '<body bgcolor="#eeeeee">',
      `$&<div class="hide">Preheader for message ${n}</div><table>${Array.from({ length: rows }, (_, r) => row(r)).join("")}</table>`,
    );
}
