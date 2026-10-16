/**
 * The search field's width beside the reader toolbar. Alone in the header, search takes the
 * whole row. Beside the toolbar it starts at 14rem: room for a query with the scope as an icon.
 * A header of 960 px leaves every default action room beside 20rem of search. While focused or
 * holding a query, search grows into the room past those 960 px, up to the field's own 520 px
 * (32.5rem), so chips stop truncating to "from:NO…" while the header has space to spare. Below
 * 960 px it holds 20rem and the toolbar folds actions, as before.
 */
export function searchSlotClass(toolbarVisible: boolean, query: string): string {
  if (!toolbarVisible) return "flex min-w-0 flex-1";
  // Important, so it beats the plain 20rem the 960 px container query sets.
  const grown = query
    ? "basis-[clamp(20rem,100cqw_-_40rem,32.5rem)]!"
    : "focus-within:basis-[clamp(20rem,100cqw_-_40rem,32.5rem)]!";
  return `flex min-w-0 flex-[0_1_14rem] @min-[960px]/bar:basis-80 ${grown}`;
}
