/**
 * The search field's width beside the reader toolbar. Alone in the header, search takes the
 * whole row. Beside the toolbar it starts at 14rem: room for a query with the scope as an icon.
 * A header of 960 px leaves every default action room beside 20rem of search. While focused or
 * holding a query, search grows into the room past those 960 px, up to the field's own 520 px
 * (32.5rem), so chips stop truncating to "from:NO…" while the header has space to spare. Below
 * 960 px it holds 20rem and the toolbar folds actions, as before. With no message selected the
 * toolbar shows no actions, so search reserves 14rem for it instead of 40rem.
 */
export function searchSlotClass(
  toolbarVisible: boolean,
  query: string,
  messageSelected: boolean,
): string {
  if (!toolbarVisible) return "flex min-w-0 flex-1";
  // Important, so it beats the plain 20rem the 960 px container query sets.
  const basis = `basis-[clamp(20rem,100cqw_-_${messageSelected ? 40 : 14}rem,32.5rem)]!`;
  const grown = query ? basis : `focus-within:${basis}`;
  return `flex min-w-0 flex-[0_1_14rem] @min-[960px]/bar:basis-80 ${grown}`;
}
