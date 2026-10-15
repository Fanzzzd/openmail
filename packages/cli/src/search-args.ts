/**
 * `openmail search -newsletter` reads `-newsletter` as a cluster of short flags, so a query
 * negation printed "Unrecognized flag: -n", `-has:attachment` printed the help (-h) and `-vip`
 * the version (-v). Before effect/cli parses the words, this moves the query words of a
 * search behind `--`, where they are operands. Long flags such as --json and --limit 5 stay
 * flags, and `-h` stays help.
 */

/** Flags of `openmail search` and the built-in ones that take the next word as their value. */
const VALUE_FLAGS = new Set([
  "--account",
  "--limit",
  "--cursor",
  "--token-budget",
  "--log-level",
  "--completions",
]);

/** The commands whose positional words are a search query. */
const QUERY_COMMANDS = new Set(["search"]);

/**
 * The words effect/cli parses: for a query command, its flags (with their values) first, then
 * `--`, then the query words in their order. Every other command line is returned unchanged.
 */
export function withQueryOperands(args: readonly string[]): readonly string[] {
  // The command is the first word that is not a flag or a flag's value.
  let at = 0;
  while (at < args.length && (args[at] ?? "").startsWith("-")) {
    if (args[at] === "--") return args;
    at += VALUE_FLAGS.has(args[at] ?? "") ? 2 : 1;
  }
  if (!QUERY_COMMANDS.has(args[at] ?? "")) return args;
  const flags: string[] = [];
  const query: string[] = [];
  for (let i = at + 1; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      query.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") || arg === "-h") {
      flags.push(arg);
      if (VALUE_FLAGS.has(arg) && i + 1 < args.length) flags.push(args[++i] ?? "");
    } else query.push(arg);
  }
  return [...args.slice(0, at + 1), ...flags, ...(query.length ? ["--", ...query] : [])];
}
