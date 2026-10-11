import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Prebuilt at build time; the search dialog downloads this index and searches in the browser.
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source, { language: "english" });
