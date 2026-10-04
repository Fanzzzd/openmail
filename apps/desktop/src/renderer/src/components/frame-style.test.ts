// @vitest-environment jsdom
import { expect, it } from "vitest";
import { DARK_CSS, fitDocument, fitScale, MIN_FIT_SCALE, PICTURES } from "./frame-style";

it("fits wide mail to the frame and leaves mail that fits alone", () => {
  expect(fitScale(600, 600)).toBe(1);
  expect(fitScale(600.5, 600)).toBe(1);
  expect(fitScale(400, 600)).toBe(1);
  expect(fitScale(800, 400)).toBe(0.5);
  expect(fitScale(2000, 400)).toBe(MIN_FIT_SCALE);
  expect(fitScale(800, 0)).toBe(1);
});

function frameDocument(natural: number, frame: number, height: number) {
  const doc = document.implementation.createHTMLDocument("mail");
  const root = doc.documentElement;
  Object.defineProperty(root, "scrollWidth", {
    get: () => (root.style.width ? Number.parseFloat(root.style.width) : natural),
  });
  Object.defineProperty(root, "clientWidth", { value: frame });
  Object.defineProperty(root, "scrollHeight", { value: height });
  root.getBoundingClientRect = () => {
    const scale = Number(/scale\(([\d.]+)\)/.exec(root.style.transform)?.[1] ?? 1);
    return DOMRect.fromRect({ width: frame, height: height * scale });
  };
  return doc;
}

it("scales the page from its top left corner and sizes the frame to the scaled height", () => {
  const doc = frameDocument(800, 400, 1000);
  const root = doc.documentElement;
  expect(fitDocument(doc, true)).toEqual({ height: 500, wide: true });
  expect(root.style.width).toBe("800px");
  expect(root.style.transform).toBe("scale(0.5)");
  expect(root.style.transformOrigin).toBe("0 0");
  expect(root.style.getPropertyPriority("transform")).toBe("important");
  // Measuring again starts from the natural width, not the one it set.
  expect(fitDocument(doc, true)).toEqual({ height: 500, wide: true });
  // At 100% the page keeps its width and scrolls sideways.
  expect(fitDocument(doc, false)).toEqual({ height: 1000, wide: true });
  expect(root.style.transform).toBe("");
  expect(root.style.width).toBe("");
});

it("reports mail that fits as not wide, so the reader offers no toggle", () => {
  const doc = frameDocument(380, 400, 700);
  expect(fitDocument(doc, true)).toEqual({ height: 700, wide: false });
  expect(doc.documentElement.style.transform).toBe("");
});

/** How many times dark mode inverts an element: the page once, plus each picture rule that applies. */
function inversions(element: Element) {
  let count = 1;
  for (let node: Element | null = element; node; node = node.parentElement)
    if (node.matches(PICTURES) && !node.matches(`:is(${PICTURES}) :is(${PICTURES})`)) count++;
  return count;
}

it("inverts each element at most once more than the page in dark mode", () => {
  expect(DARK_CSS).toContain(`:is(${PICTURES}) :is(${PICTURES}) { filter: none; }`);
  document.body.innerHTML = `
    <div id="none" style="background-image:none">SECRET</div>
    <div id="color" style="background: #fff">Plain</div>
    <div id="photo" style="background: URL(cid:hero)"><p id="caption">Hi</p><img id="nested"></div>
    <div id="gradient" style="background-image: linear-gradient(red, blue)">Sale</div>
    <table><tr><td id="legacy" background="cid:tile">Cell</td></tr></table>
    <picture id="picture"><img id="inner"></picture>
    <img id="logo">`;
  const count = (id: string) => inversions(document.getElementById(id)!);
  // Text without a picture behind it turns light with the page.
  expect(count("none")).toBe(1);
  expect(count("color")).toBe(1);
  // Pictures and everything drawn on them keep the sender's colors.
  for (const id of ["photo", "caption", "nested", "gradient", "legacy", "picture", "inner", "logo"])
    expect(count(id), id).toBe(2);
});
