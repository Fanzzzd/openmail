import { ElementType, parseDocument } from "htmlparser2";
import { Option, Record, Schema } from "effect";
import { READER_TAGS } from "./reader-sanitize.js";
import { ident, parse, walk } from "./css-tree-browser.js";

export const VisibleRemovalRule = Schema.Literals([
  "hidden-attribute",
  "aria-hidden",
  "display-none",
  "content-visibility",
  "zoom",
  "uncertain-css",
  "uncertain-paint",
  "positioned-overlay",
  "visibility",
  "opacity",
  "font-size-zero",
  "font-size-small",
  "colour-match",
  "off-screen",
  "scale",
  "clipping",
  "filter-opacity",
  "omit-tag",
  "mso-conditional-comment",
  "comment",
]);
export type VisibleRemovalRule = typeof VisibleRemovalRule.Type;
export const VisibleRemovalSource = Schema.Literals([
  "html-attribute",
  "inline-style",
  "stylesheet-rule",
  "inherited",
  "omit-tag",
  "comment",
]);
export type VisibleRemovalSource = typeof VisibleRemovalSource.Type;
const TextCounts = Schema.Struct({
  textNodes: Schema.mutableKey(Schema.Int),
  characters: Schema.mutableKey(Schema.Int),
});
export type TextCounts = typeof TextCounts.Type;
export interface VisibleTextObserver {
  removed: (rule: VisibleRemovalRule, source: VisibleRemovalSource, counts: TextCounts) => void;
  retained: (characters: number) => void;
}

// Never use an untrusted tag, selector identifier or pseudo-class name as an output key.
const HtmlTag = Schema.Literals([
  ...READER_TAGS,
  "title",
  "script",
  "meta",
  "link",
  "base",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "form",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "audio",
  "video",
  "canvas",
  "datalist",
  "other",
]);
const SelectorShape = Schema.Literals([
  "selector",
  "selector-list",
  "class-selector",
  "id-selector",
  "type-selector",
  "universal-selector",
  "attribute-selector",
  "pseudo-class",
  "pseudo-element",
  ":not",
  ":is",
  ":where",
  ":has",
  "combinator",
  "descendant-combinator",
  "child-combinator",
  "sibling-combinator",
  "@media",
  "@supports",
  "@layer",
  "@container",
  "@page",
  "@import",
  "@font-face",
  "@other",
  "raw-css",
  "parse-error",
]);
const zeros = <K extends string>(keys: Schema.Literals<readonly K[]>) =>
  Schema.decodeUnknownSync(Schema.Record(keys, Schema.Int))(
    Object.fromEntries(keys.literals.map((key) => [key, 0])),
  );
export const HtmlStructure = Schema.Struct({
  htmlCharacters: Schema.Int,
  elements: Schema.Int,
  tagCounts: Schema.Record(HtmlTag, Schema.Int),
  textNodes: Schema.Int,
  textCharacters: Schema.Int,
  commentNodes: Schema.Int,
  msoConditionalCommentNodes: Schema.Int,
  maxDepth: Schema.Int,
  bodyInsideHead: Schema.Int,
  textNodesInsideHead: Schema.Int,
  textCharactersInsideHead: Schema.Int,
  stylesheetBlocks: Schema.Int,
  inlineStyleAttributes: Schema.Int,
  stylesheetSelectorShapes: Schema.Record(SelectorShape, Schema.Int),
});
export type HtmlStructure = typeof HtmlStructure.Type;
export const VisibleTextExplanation = Schema.Struct({
  structure: HtmlStructure,
  removedByRule: Schema.Record(VisibleRemovalRule, TextCounts),
  removedBySource: Schema.Record(VisibleRemovalSource, TextCounts),
  retainedTextNodes: Schema.Int,
  retainedCharacters: Schema.Int,
  visibleCharacters: Schema.Int,
  hidden: Schema.Boolean,
  budgetExceeded: Schema.Boolean,
  cssRuleBudgetHits: Schema.Int,
  nestingDepthLimitHits: Schema.Int,
});
export type VisibleTextExplanation = typeof VisibleTextExplanation.Type;
export const MessageTextExplanation = Schema.Struct({
  textPlainNonEmpty: Schema.Boolean,
  decodedTextPlainNonEmpty: Schema.Boolean,
  cachedHtml: HtmlStructure,
  original: VisibleTextExplanation,
  sanitized: VisibleTextExplanation,
});
export type MessageTextExplanation = typeof MessageTextExplanation.Type;

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
export function subtreeTextCounts(node: HtmlNode): TextCounts {
  const counts: TextCounts = { textNodes: 0, characters: 0 };
  const pending = [node];
  while (pending.length) {
    const child = pending.pop();
    if (!child) continue;
    if (child.type === ElementType.Text) {
      counts.textNodes++;
      counts.characters += child.data.length;
    } else if ("children" in child) for (const nested of child.children) pending.push(nested);
  }
  return counts;
}

/** A separate inert AST walk reports shapes only; it does not change CSS matching. */
function stylesheetShapes(css: string, counts: Record<typeof SelectorShape.Type, number>) {
  try {
    const ast = parse(css);
    walk(ast, (node) => {
      switch (node.type) {
        case "Selector":
          counts.selector++;
          break;
        case "SelectorList":
          counts["selector-list"]++;
          break;
        case "ClassSelector":
          counts["class-selector"]++;
          break;
        case "IdSelector":
          counts["id-selector"]++;
          break;
        case "TypeSelector":
          counts[node.name === "*" ? "universal-selector" : "type-selector"]++;
          break;
        case "AttributeSelector":
          counts["attribute-selector"]++;
          break;
        case "PseudoElementSelector":
          counts["pseudo-element"]++;
          break;
        case "PseudoClassSelector": {
          counts["pseudo-class"]++;
          const shape = Option.getOrNull(
            Schema.decodeUnknownOption(SelectorShape)(`:${ident.decode(node.name).toLowerCase()}`),
          );
          if (shape) counts[shape]++;
          break;
        }
        case "Combinator":
          counts.combinator++;
          if (node.name === " ") counts["descendant-combinator"]++;
          else if (node.name === ">") counts["child-combinator"]++;
          else if (node.name === "+" || node.name === "~") counts["sibling-combinator"]++;
          break;
        case "Atrule": {
          const shape = Option.getOrNull(
            Schema.decodeUnknownOption(SelectorShape)(`@${ident.decode(node.name).toLowerCase()}`),
          );
          counts[shape ?? "@other"]++;
          break;
        }
        case "Raw":
          counts["raw-css"]++;
          break;
        default:
          break;
      }
    });
  } catch {
    counts["parse-error"]++;
  }
}

export function inspectHtmlStructure(
  html: string,
  commentRemoval?: VisibleTextObserver["removed"],
): HtmlStructure {
  const root = parseDocument(html);
  const tagCounts = { ...zeros(HtmlTag) };
  const shapes = { ...zeros(SelectorShape) };
  const result = {
    htmlCharacters: html.length,
    elements: 0,
    tagCounts,
    textNodes: 0,
    textCharacters: 0,
    commentNodes: 0,
    msoConditionalCommentNodes: 0,
    maxDepth: 0,
    bodyInsideHead: 0,
    textNodesInsideHead: 0,
    textCharactersInsideHead: 0,
    stylesheetBlocks: 0,
    inlineStyleAttributes: 0,
    stylesheetSelectorShapes: shapes,
  };
  const pending = root.children.map((node) => ({ node, depth: 1, insideHead: false }));
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) continue;
    const { node, depth, insideHead } = entry;
    result.maxDepth = Math.max(result.maxDepth, depth);
    if (node.type === ElementType.Text) {
      result.textNodes++;
      result.textCharacters += node.data.length;
      if (insideHead) {
        result.textNodesInsideHead++;
        result.textCharactersInsideHead += node.data.length;
      }
    } else if (node.type === ElementType.Comment) {
      result.commentNodes++;
      const conditional = /^\s*\[if\b[^\]]*\bmso\b/i.test(node.data);
      if (conditional) result.msoConditionalCommentNodes++;
      if (commentRemoval) {
        // Comment bodies are inert. Count potential text inside them without exposing it.
        const body = node.data.replace(/^\s*\[if\b[^\]]*\]>/i, "").replace(/<!\[endif\]\s*$/i, "");
        const counts = subtreeTextCounts(parseDocument(body));
        commentRemoval(conditional ? "mso-conditional-comment" : "comment", "comment", counts);
      }
    } else if ("name" in node && "attribs" in node) {
      result.elements++;
      const tag = Option.getOrNull(Schema.decodeUnknownOption(HtmlTag)(node.name)) ?? "other";
      tagCounts[tag]++;
      if (node.name === "body" && insideHead) result.bodyInsideHead++;
      if (node.attribs.style !== undefined) result.inlineStyleAttributes++;
      if (node.name === "style") {
        result.stylesheetBlocks++;
        stylesheetShapes(
          node.children
            .filter((child) => child.type === ElementType.Text)
            .map((child) => child.data)
            .join(""),
          shapes,
        );
      }
    }
    if ("children" in node)
      for (const child of node.children)
        pending.push({
          node: child,
          depth: depth + 1,
          insideHead: insideHead || ("name" in node && node.name === "head"),
        });
  }
  return result;
}

export function createVisibleTextTrace(html: string) {
  const removedByRule = Record.map(zeros(VisibleRemovalRule), (): TextCounts => ({
    textNodes: 0,
    characters: 0,
  }));
  const removedBySource = Record.map(zeros(VisibleRemovalSource), (): TextCounts => ({
    textNodes: 0,
    characters: 0,
  }));
  let retainedTextNodes = 0,
    retainedCharacters = 0,
    cssRuleBudgetHits = 0,
    nestingDepthLimitHits = 0;
  const observer: VisibleTextObserver = {
    removed: (rule, source, counts) => {
      for (const aggregate of [removedByRule[rule], removedBySource[source]]) {
        aggregate.textNodes += counts.textNodes;
        aggregate.characters += counts.characters;
      }
    },
    retained: (characters) => {
      retainedTextNodes++;
      retainedCharacters += characters;
    },
  };
  const structure = inspectHtmlStructure(html, observer.removed);
  return {
    observer,
    diagnostic: (kind: "css-rule-budget" | "nesting-depth-limit") => {
      if (kind === "css-rule-budget") cssRuleBudgetHits++;
      else nestingDepthLimitHits++;
    },
    finish: (result: {
      text: string;
      hidden: boolean;
      flags?: readonly string[];
    }): VisibleTextExplanation => ({
      structure,
      removedByRule,
      removedBySource,
      retainedTextNodes,
      retainedCharacters,
      visibleCharacters: result.text.length,
      hidden: result.hidden,
      budgetExceeded: result.flags?.includes("budget-exceeded") ?? false,
      cssRuleBudgetHits,
      nestingDepthLimitHits,
    }),
  };
}
