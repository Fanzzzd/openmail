import { assert, it } from "@effect/vitest";

import { renderMarkdown } from "./markdown.js";

it("renders code blocks, quotes and links", () => {
  const html = renderMarkdown(
    "**好**\n\n```ts\nconst a = 1 < 2;\n```\n\n> quoted\n\nhttps://x.com",
  );
  assert.match(html, /<strong>好<\/strong>/);
  assert.match(
    html,
    /<pre style="[^"]+"><code style="[^"]+" class="language-ts">const a = 1 &lt; 2;/,
  );
  assert.match(html, /<blockquote style=/);
  assert.match(html, /<a href="https:\/\/x\.com">/);
});

it("escapes typed HTML and refuses script links", () => {
  const html = renderMarkdown(
    "<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))",
  );
  assert.notMatch(html, /<script|<img|href="javascript/i);
  assert.match(html, /&lt;script&gt;/);
});

it("links bare domains and addresses", () => {
  const html = renderMarkdown("www.example.com or bob@example.com");
  assert.match(html, /<a href="http:\/\/www\.example\.com">www\.example\.com<\/a>/);
  assert.match(html, /<a href="mailto:bob@example\.com">bob@example\.com<\/a>/);
});
