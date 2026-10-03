import {
  parse as browserParse,
  generate as browserGenerate,
  walk as browserWalk,
  ident as browserIdent,
} from "css-tree/dist/csstree.esm";

// Keep published declarations on the package's typed API, while runtime imports
// always select the browser bundle (including source-based mobile consumers).
export const parse: typeof import("css-tree").parse = browserParse;
export const generate: typeof import("css-tree").generate = browserGenerate;
export const walk: typeof import("css-tree").walk = browserWalk;
export const ident: typeof import("css-tree").ident = browserIdent;
export type { CssNode, EnterOrLeaveFn } from "css-tree";
