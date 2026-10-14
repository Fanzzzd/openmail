import { expect, it } from "vitest";
import { citedParts } from "./citations";

const sources = [{ id: "gmail:a@example.com/m1" }, { id: "gmail:a@example.com/m2" }];

it("known ids become numbers; other brackets stay text", () => {
  expect(
    citedParts(
      "Done [gmail:a@example.com/m2]; both [gmail:a@example.com/m1; gmail:a@example.com/m2] [x] [gmail:a@example.com/m3]",
      sources,
    ),
  ).toEqual([
    { kind: "text", text: "Done " },
    { kind: "cite", numbers: [2] },
    { kind: "text", text: "; both " },
    { kind: "cite", numbers: [1, 2] },
    { kind: "text", text: " [x] [gmail:a@example.com/m3]" },
  ]);
});

it("text without citations comes back whole", () => {
  expect(citedParts("No sources", [])).toEqual([{ kind: "text", text: "No sources" }]);
  expect(citedParts("", sources)).toEqual([]);
});

const imap = [
  { id: "imap:a@x.com/1:5:Sent Items" },
  { id: "imap:a@x.com/1:7:[Gmail]/Sent Mail" },
  { id: "imap:a@x.com/1:7:[Gmail]/Sent Mail Archive" },
  { id: "imap:a@x.com/1:2:INBOX" },
];

it("ids with spaces and brackets in the folder path become numbers", () => {
  expect(citedParts("See [imap:a@x.com/1:5:Sent Items].", imap)).toEqual([
    { kind: "text", text: "See " },
    { kind: "cite", numbers: [1] },
    { kind: "text", text: "." },
  ]);
  expect(citedParts("See [imap:a@x.com/1:7:[Gmail]/Sent Mail]", imap)).toEqual([
    { kind: "text", text: "See " },
    { kind: "cite", numbers: [2] },
  ]);
});

it("the longest known id wins, and one bracket can hold several ids", () => {
  expect(
    citedParts(
      "[imap:a@x.com/1:7:[Gmail]/Sent Mail Archive] and [imap:a@x.com/1:7:[Gmail]/Sent Mail, imap:a@x.com/1:5:Sent Items; imap:a@x.com/1:2:INBOX]",
      imap,
    ),
  ).toEqual([
    { kind: "cite", numbers: [3] },
    { kind: "text", text: " and " },
    { kind: "cite", numbers: [2, 1, 4] },
  ]);
  expect(citedParts("[imap:a@x.com/1:5:Sent Items imap:a@x.com/1:2:INBOX]", imap)).toEqual([
    { kind: "cite", numbers: [1, 4] },
  ]);
});

it("unknown ids and partial matches stay text", () => {
  const text =
    "[imap:a@x.com/1:5:Sent] [imap:a@x.com/1:5:Sent Items, imap:a@x.com/1:9:Drafts] [imap:a@x.com/1:2:INBOX extra] [[Gmail]/Sent Mail]";
  expect(citedParts(text, imap)).toEqual([{ kind: "text", text }]);
});
