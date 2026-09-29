import { assert, describe, it } from "@effect/vitest";

import { prepareMessageHtml } from "./reader-html.js";
import { TRACKERS, trackerFor } from "./trackers.js";

describe("trackerFor", () => {
  it("covers at least 75 services, each named once", () => {
    const names = TRACKERS.map((t) => t.name);
    assert.isAtLeast(names.length, 75);
    assert.strictEqual(new Set(names).size, names.length);
  });

  it("matches open pixels of the common services", () => {
    const cases: [string, string][] = [
      ["https://example.us1.list-manage.com/track/open.php?u=1&id=2", "Mailchimp"],
      ["https://u123.ct.sendgrid.net/wf/open?upn=abc", "SendGrid"],
      ["https://t.hubspotemail.net/e1t/to/abc", "HubSpot"],
      ["https://email.mg.example.com.mailgun.org/o/abc", "Mailgun"],
      ["https://api.mixpanel.com/track/?data=abc&ip=1&img=1", "Mixpanel"],
      ["https://track.customer.io/e/o/abc", "Customer.io"],
      ["https://intercom-mail.com/via/o?h=abc", "Intercom"],
      ["https://trk.klaviyomail.com/u/abc", "Klaviyo"],
      ["https://sdk.iad-01.braze.com/api/open?x=1", "Braze"],
      ["https://links.iterable.com/e/eo?_t=abc", "Iterable"],
      ["https://123-abc-456.mktoedge.com/trk?t=1", "Marketo"],
      ["https://go.pardot.com/l/123/abc", "Salesforce Pardot"],
      ["https://eotrx.substackcdn.com/open?token=abc", "Substack"],
      ["https://link.mail.beehiiv.com/o/abc", "beehiiv"],
      ["https://open.convertkit-mail2.com/abc", "ConvertKit"],
      ["https://r.superhuman.com/abc.gif", "Superhuman"],
      ["https://mailtrack.io/trace/mail/abc.png", "Mailtrack"],
      ["https://mailfoogae.appspot.com/t?sender=abc", "Streak"],
      ["https://t.yesware.com/t/abc/o.gif", "Yesware"],
      ["https://track.mixmax.com/api/track/v2/abc", "Mixmax"],
      ["https://mltrk.io/pixel/abc", "Hunter"],
      ["https://eu-west-1.awstrack.me/I0/0102/abc", "Amazon SES"],
      ["https://abc.cmail20.com/t/r-o-abc/o.gif", "Campaign Monitor"],
      ["//www.google-analytics.com/collect?v=1&t=event", "Google Analytics"],
      ["https://www.linkedin.com/emimp/ip_abc.gif", "LinkedIn"],
    ];
    for (const [url, name] of cases) assert.strictEqual(trackerFor(url), name, url);
  });

  it("leaves real content from the same hosts and other URLs alone", () => {
    for (const url of [
      "https://mcusercontent.com/abc/images/logo.png",
      "https://gallery.mailchimp.com/abc/images/hero.jpg",
      "https://substack.com/img/logo.png",
      "https://media.licdn.com/dms/image/abc",
      "https://www.linkedin.com/in/someone",
      "https://www.facebook.com/images/logo.png",
      "https://example.com/open-source.png",
      "cid:logo@example",
      "data:image/png;base64,AAAA",
      "not a url",
    ]) {
      assert.strictEqual(trackerFor(url), undefined, url);
    }
  });

  it("matches a host by suffix only at a dot", () => {
    assert.strictEqual(trackerFor("https://notmailtrack.io/x.png"), undefined);
    assert.strictEqual(trackerFor("https://a.mailtrack.io/x.png"), "Mailtrack");
  });
});

describe("prepareMessageHtml", () => {
  it("removes tracker images and CSS, keeps other images, notes each service once", () => {
    const html = `<p>Hi</p>
<img src="https://u1.ct.sendgrid.net/wf/open?upn=a" width="1" height="1">
<img src='https://u1.ct.sendgrid.net/wf/open?upn=b'>
<img src="https://cdn.example.com/hero.png" alt="Hero">
<div style="background-image:url('https://example.us1.list-manage.com/track/open.php?u=1')">x</div>
<style>.a { background: url(https://t.hubspotemail.net/e1t/o/abc) }</style>`;
    const out = prepareMessageHtml(html);
    assert.deepStrictEqual(out.trackers.toSorted(), ["HubSpot", "Mailchimp", "SendGrid"]);
    assert.strictEqual(out.pixels, 0);
    assert.isTrue(out.hasRemote);
    assert.notInclude(out.html, "sendgrid.net");
    assert.notInclude(out.html, "list-manage.com");
    assert.notInclude(out.html, "hubspotemail.net");
    assert.include(out.html, 'src="https://cdn.example.com/hero.png"');
    // Tracker images are removed whole: no broken-image icon remains.
    assert.strictEqual(out.html.match(/<img/g)?.length, 1);
    assert.include(out.html, "<p>Hi</p>");
  });

  it("treats a remote 1×1 image from an unknown host as a pixel", () => {
    const out = prepareMessageHtml(
      `<img src="https://mail.shop.example/p.gif?id=9" width="1" height="1" border="0">` +
        `<img src="https://cdn.shop.example/logo.png" style="width:1px;height:1px">` +
        `<img src="data:image/gif;base64,R0lG" width="1" height="1">`,
    );
    assert.strictEqual(out.pixels, 2);
    assert.deepStrictEqual(out.trackers, []);
    assert.isFalse(out.hasRemote);
    assert.include(out.html, "data:image/gif;base64,R0lG");
  });

  it("inlines cid: images and drops tracker entries from srcset", () => {
    const out = prepareMessageHtml(
      `<img src="cid:logo@x"><img src="cid:missing@x">` +
        `<img srcset="https://mailtrack.io/a.png 1x, https://cdn.example.com/b.png 2x">`,
      { inline: { "logo@x": "data:image/png;base64,AAAA" } },
    );
    assert.include(out.html, 'src="data:image/png;base64,AAAA"');
    assert.include(out.html, 'src="cid:missing@x"');
    assert.include(out.html, 'srcset="https://cdn.example.com/b.png 2x"');
    assert.deepStrictEqual(out.trackers, ["Mailtrack"]);
  });

  it("leaves links alone and reports no remote content for plain mail", () => {
    const html = `<a href="https://example.us1.list-manage.com/track/click?u=1">Read</a>`;
    const out = prepareMessageHtml(html);
    assert.strictEqual(out.html, html);
    assert.isFalse(out.hasRemote);
    assert.deepStrictEqual(out.trackers, []);
  });

  it("counts remote stylesheets as remote content", () => {
    const out = prepareMessageHtml(
      `<link rel="stylesheet" href="https://fonts.example.com/a.css">`,
    );
    assert.isTrue(out.hasRemote);
  });
});
