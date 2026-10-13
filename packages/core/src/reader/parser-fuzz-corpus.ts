/** Synthetic sender-controlled inputs; shared by core and browser parser tests. */
export const hostileHtml = [
  '<script>alert(1)</script><img src="https://evil.test/pixel" onerror="alert(1)">',
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  '<svg><style><a id="</style><img src=x onerror=alert(1)>">',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<form><input name="__proto__"><button formaction="javascript:alert(1)">send</button></form>',
  '<a href="java&#x09;script:alert(1)" onclick="alert(1)">link</a>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://evil.test/x">',
  '<base href="https://evil.test/"><link rel="stylesheet" href="theme.css"><img src="photo">',
  '<style>@import "https://evil.test/x";p{background:u\\72l(https://evil.test/y)}</style>',
  "<p style=\"background:image-set('https://evil.test/x' 1x);behavior:url(x)\">text</p>",
  '<img srcset="https://evil.test/a 1x, https://evil.test/b 2x" background="//evil.test/c">',
  "<textarea>&lt;img src=x onerror=alert(1)&gt;</textarea><xmp><img src=x onerror=alert(1)>",
  "<!-- unterminated <script>alert(1)</script>",
  '<p title="\0" style="display:none">hidden instruction</p><p>visible</p>',
];

export const htmlTokens = [
  ...hostileHtml,
  "<div>",
  "</div>",
  "<p>",
  "</p>",
  "<table>",
  "</table>",
  "<tr>",
  "<td>",
  "<ul>",
  "<li>",
  "</li>",
  "<b>",
  "</b>",
  "<i>",
  "</i>",
  "<pre>",
  "</pre>",
  '<span style="font-weight:700">',
  "</span>",
  "text",
  " &amp; ",
  "\0",
  "<!--",
  "-->",
];

export const hostileMime = [
  "Subject: =?x-invalid?B?////?=\r\nContent-Type: text/plain; charset=x-invalid\r\n\r\n\0text",
  'Content-Type: multipart/mixed; boundary="missing"\r\n\r\n--different\r\nbody',
  'Content-Type: multipart/mixed; boundary=""\r\n\r\n--\r\n',
  "Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename*=UTF-8''%FF%00%ZZ\r\n\r\nbytes",
  "Content-Type: application/pkcs7-mime; smime-type=signed-data\r\nContent-Transfer-Encoding: base64\r\n\r\nMIAwgAQEAAAAAA==",
  "Content-Type: application/pkcs7-mime\r\nContent-Transfer-Encoding: base64\r\n\r\nMP///////w==",
  "Content-Type: text/plain\r\n\r\nbegin 644 ../../evil.txt\nM!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`\nend",
  "Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: x-uuencode\r\n\r\nbegin 644 a.txt\n#0V%T\n`\nend",
  'Subject: (unterminated comment\r\nFrom: "unterminated <a@b.test>\r\n\r\nbody',
];

export const nestedHtml = (depth: number) =>
  `${"<div>".repeat(depth)}visible${"</div>".repeat(depth)}`;
