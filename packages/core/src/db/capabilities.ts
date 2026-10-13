import { Context } from "effect";

/**
 * The database as an Effect SqlClient, migrated before anything uses it. The
 * client turns on WAL and a 5 s busy timeout: the app and the CLI write
 * concurrently, and a second writer should wait instead of failing with
 * SQLITE_BUSY. `":memory:"` gives a fresh database for tests; any other name
 * gets its parent directory created first.
 */
export class DatabaseCapabilities extends Context.Service<
  DatabaseCapabilities,
  { readonly vectors: boolean }
>()("openmail/DatabaseCapabilities") {}
