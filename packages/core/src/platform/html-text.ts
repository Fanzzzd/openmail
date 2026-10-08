import { Context, Effect } from "effect";
import { htmlToText } from "../mime.js";

/** HTML-to-text extraction for provider parsing. Node replaces the inline default with a worker pool. */
export interface HtmlText {
  readonly htmlToText: (html: string) => Effect.Effect<string>;
  /** Extractions that can run at once; parse loops use it to keep every worker busy. */
  readonly concurrency: number;
}
export const HtmlText = Context.Reference<HtmlText>("openmail/HtmlText", {
  defaultValue: () => ({
    htmlToText: (html) => Effect.sync(() => htmlToText(html)),
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
