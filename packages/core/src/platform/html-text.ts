import { Context, Effect } from "effect";
import { htmlToText } from "../mime/mime.js";
import { searchVisibleText } from "../visible-text/visible-text.js";

/** HTML-to-text extraction off the caller's thread. Node replaces the inline default with worker pools. */
export interface HtmlText {
  /** Text for the word index, from provider parsing. */
  readonly htmlToText: (html: string) => Effect.Effect<string>;
  /**
   * `searchVisibleText`: the text search snippets show. Tens of milliseconds per HTML body, so
   * Node runs it on its own worker. `urgent` puts a search's request ahead of the background fill.
   */
  readonly visibleText: (
    plain: string,
    html: string,
    options?: { readonly urgent?: boolean },
  ) => Effect.Effect<string>;
  /** Extractions that can run at once; parse loops use it to keep every worker busy. */
  readonly concurrency: number;
}
export const HtmlText = Context.Reference<HtmlText>("openmail/HtmlText", {
  defaultValue: () => ({
    htmlToText: (html) => Effect.sync(() => htmlToText(html)),
    visibleText: (plain, html) => Effect.sync(() => searchVisibleText(plain, html)),
    concurrency: 1,
  }),
});

/** A parsed message waiting for the text of `html`; plain-text bodies leave `html` unset. */
export interface HtmlBody<A> {
  readonly html?: string;
  readonly finish: (text: string) => A;
}

export const finishInline = <A>(body: HtmlBody<A>): A =>
  body.finish(body.html === undefined ? "" : htmlToText(body.html));

export const finishWith = <A>(service: HtmlText, body: HtmlBody<A>): Effect.Effect<A> =>
  body.html === undefined
    ? Effect.sync(() => body.finish(""))
    : Effect.map(service.htmlToText(body.html), body.finish);
