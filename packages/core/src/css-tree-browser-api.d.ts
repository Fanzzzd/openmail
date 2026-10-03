// The package's documented browser bundle has the same API as its root export.
declare module "css-tree/dist/csstree.esm" {
  export { parse, generate, walk, ident, type CssNode, type EnterOrLeaveFn } from "css-tree";
}
