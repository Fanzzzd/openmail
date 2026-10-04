import { expect, it, vi } from "vitest";
import { MessageInlineImages } from "./inline-images";

it("fetches only CID mail and reuses the same message promise and image map across refreshes and HTML toggles", async () => {
  const images = { photo: "data:image/png;base64,AQID" };
  const fetch = vi.fn(async () => images);
  const loader = new MessageInlineImages(fetch);
  expect(await loader.load("plain", '<img src="https://example.test/image.png">')).toEqual({});
  expect(fetch).not.toHaveBeenCalled();
  const first = loader.load("mail", '<img src="cid:photo">');
  expect(loader.load("mail", '<img src="cid:photo">')).toBe(first);
  expect(await first).toBe(images);
  for (let revision = 0; revision < 3; revision++)
    expect(await loader.load("mail", '<img src="cid:photo">')).toBe(images);
  expect(fetch).toHaveBeenCalledTimes(1);
  await loader.load("other", '<img src="CID:photo">');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("retries a failed CID download without retaining an error as the message cache", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ photo: "data:image/png;base64,AQID" });
  const loader = new MessageInlineImages(fetch);
  await expect(loader.load("mail", '<img src="cid:photo">')).rejects.toThrow("offline");
  expect(await loader.load("mail", '<img src="cid:photo">')).toEqual({
    photo: "data:image/png;base64,AQID",
  });
});
it("does not download the message source when cid: appears only in text or links", async () => {
  const fetch = vi.fn(async () => ({}));
  const loader = new MessageInlineImages(fetch);
  expect(await loader.load("text", "<p>Reference cid:photo in the text</p>")).toEqual({});
  expect(await loader.load("link", '<a href="https://example.test/?q=cid:photo">open</a>')).toEqual(
    {},
  );
  expect(fetch).not.toHaveBeenCalled();
  await loader.load("background", '<td background="cid:banner">x</td>');
  expect(fetch).toHaveBeenCalledTimes(1);
});
