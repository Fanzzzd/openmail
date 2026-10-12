import { expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { externalLinkTargets, frameLinkTarget, listenForLinkHints } from "./email-links";
import { externalUrl } from "../../../../../shared/external-url";

it("uses the innermost SVG link rather than a surrounding HTML link", () => {
  for (const attribute of [
    'xlink:href="https://evil.example/login"',
    'href="https://evil.example/login"',
    "",
  ]) {
    const { document } = parseHTML("<html><body></body></html>");
    Object.defineProperty(document, "baseURI", { value: "https://reader.test/message" });
    const outer = document.createElement("a");
    outer.setAttribute("href", "https://bank.com");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const link = document.createElementNS("http://www.w3.org/2000/svg", "a");
    if (attribute)
      link.setAttribute(
        attribute.startsWith("xlink:") ? "xlink:href" : "href",
        "https://evil.example/login",
      );
    const inner = document.createElementNS("http://www.w3.org/2000/svg", "text");
    link.append(inner);
    svg.append(link);
    outer.append(svg);
    document.body.append(outer);
    Object.defineProperty(document, "elementFromPoint", { value: () => inner });
    Object.defineProperty(document, "activeElement", { value: inner });
    const pointer = new Event("mousemove");
    Object.defineProperties(pointer, { clientX: { value: 1 }, clientY: { value: 1 } });
    const expected = attribute ? "https://evil.example/login" : null;
    expect(frameLinkTarget(document, pointer)).toBe(expected);
    expect(frameLinkTarget(document, new Event("focusin"))).toBe(expected);
  }
});

it("removes userinfo so a spoofed login hint starts with its real destination", () => {
  expect(externalUrl("https://www.paypal.com:password@evil.example/login", "about:srcdoc")).toBe(
    "https://evil.example/login",
  );
  expect(externalUrl("http://bank.com@evil.example:8080/?q=1", "about:srcdoc")).toBe(
    "http://evil.example:8080/?q=1",
  );
});

it("reads namespace-only links and the current SVG animated href", () => {
  const { document } = parseHTML('<svg><a id="link"><text>Click</text></a></svg>');
  Object.defineProperty(document, "baseURI", { value: "https://reader.test/message" });
  const link = document.getElementById("link");
  expect(link).not.toBeNull();
  if (!link) throw new Error("Missing link fixture");
  Object.defineProperty(document, "activeElement", { value: link });
  vi.spyOn(link, "getAttributeNS").mockImplementation((namespace, name) =>
    namespace === "http://www.w3.org/1999/xlink" && name === "href"
      ? "https://namespace.example/link"
      : null,
  );
  expect(frameLinkTarget(document, new Event("focusin"))).toBe("https://namespace.example/link");
  Object.defineProperty(link, "href", {
    value: { baseVal: "https://base.example/link", animVal: "https://current.example/link" },
  });
  expect(frameLinkTarget(document, new Event("focusin"))).toBe("https://current.example/link");
});

it("HTML self targets, areas and SVG links use the existing external popup path", () => {
  const { document } = parseHTML(
    '<a target="_self" href="https://example.com">HTML</a><area target="reader" href="https://example.com"><svg><a xlink:href="https://evil.example">SVG</a></svg>',
  );
  externalLinkTargets(document);
  const links = [...document.querySelectorAll("a,area")];
  expect(links).toHaveLength(3);
  expect(links.map((link) => link.getAttribute("target"))).toEqual(["_blank", "_blank", "_blank"]);
});

it("shows navigable destinations as text, including relative and mailto links", () => {
  expect(externalUrl("../message?q=1", "https://example.com/mail/inbox")).toBe(
    "https://example.com/message?q=1",
  );
  expect(externalUrl("https://example.com/?a=<script>", "about:srcdoc")).toBe(
    "https://example.com/?a=%3Cscript%3E",
  );
  expect(externalUrl("mailto:a@example.com", "about:srcdoc")).toBe("mailto:a@example.com");
  for (const url of [
    null,
    "",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/secret",
    "relative",
  ]) {
    expect(externalUrl(url, "about:srcdoc")).toBeNull();
  }
});

it("reads only events from the bound frame document, clears hints and removes old listeners", () => {
  const frame = new EventTarget();
  const unrelated = new EventTarget();
  const show = vi.fn<(url: string | null) => void>();
  const target = vi.fn(() => "https://example.com/destination");
  const dispose = listenForLinkHints(frame, target, show);
  unrelated.dispatchEvent(new Event("mouseover"));
  frame.dispatchEvent(new MessageEvent("message", { data: { url: "https://evil.test" } }));
  expect(show).not.toHaveBeenCalled();
  frame.dispatchEvent(new Event("mouseover"));
  expect(show).toHaveBeenLastCalledWith("https://example.com/destination");
  for (const name of ["mouseout", "mouseleave", "focusout", "blur"]) {
    frame.dispatchEvent(new Event(name));
    expect(show).toHaveBeenLastCalledWith(null);
  }
  frame.dispatchEvent(new Event("focusin"));
  expect(show).toHaveBeenLastCalledWith("https://example.com/destination");
  dispose();
  expect(show).toHaveBeenLastCalledWith(null);
  show.mockClear();
  frame.dispatchEvent(new Event("mousemove"));
  frame.dispatchEvent(new Event("focusin"));
  expect(show).not.toHaveBeenCalled();
});
