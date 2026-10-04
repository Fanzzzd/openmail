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
    assert.isTrue(out.hasCid);
  });

  it("counts cid: as embedded only where a resource references it", () => {
    assert.isFalse(prepareMessageHtml("<p>Reply with cid:logo in the text</p>").hasCid);
    assert.isTrue(prepareMessageHtml(`<div style="background:url('cid:bg')">x</div>`).hasCid);
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

it("resolves mail base URLs before stripping base tags, including CSS and srcset", () => {
  const result = prepareMessageHtml(
    `<base href="https://shop.example/mail/"><a href="../offer?q=1&amp;x=2">Offer</a><img src="hero.png"><img srcset="small.png 1x, ../large.png 2x"><style>.hero {background:url(bg.png)}</style>`,
  );
  assert.notMatch(result.html, /<base\b/i);
  assert.include(result.html, 'href="https://shop.example/offer?q=1&amp;x=2"');
  assert.include(result.html, 'src="https://shop.example/mail/hero.png"');
  assert.include(
    result.html,
    'srcset="https://shop.example/mail/small.png 1x, https://shop.example/large.png 2x"',
  );
  assert.include(result.html, "url(https://shop.example/mail/bg.png)");
  assert.isTrue(result.hasRemote);
});

it("upgrades HTTP resources to HTTPS while leaving HTTP navigation links available", () => {
  const result = prepareMessageHtml(
    '<base href="http://shop.example/mail/"><img src="hero.png"><a href="offer">Offer</a>',
  );
  assert.include(result.html, 'src="https://shop.example/mail/hero.png"');
  assert.include(result.html, 'href="http://shop.example/mail/offer"');
});

it("uses the first web base, ignores unsafe bases and rechecks relative trackers and pixels", () => {
  const html =
    '<BASE HREF="https://safe.example/mail/?a=1&amp;b=2"><base href="https://evil.example/"><a href="?offer=1&amp;id=2">Offer</a><img src="../pixel" width="1" height="1"><img src="//mailtrack.io/open"><svg><image xlink:href="http://safe.example/image.svg"></image></svg>';
  const result = prepareMessageHtml(html);
  assert.include(result.html, 'href="https://safe.example/mail/?offer=1&amp;id=2"');
  assert.notInclude(result.html, "evil.example");
  assert.notInclude(result.html, "mailtrack.io");
  assert.include(result.html, 'xlink:href="https://safe.example/image.svg"');
  assert.strictEqual(result.pixels, 1);
  assert.deepEqual(result.trackers, ["Mailtrack"]);
  for (const base of [
    "file:///private/",
    "javascript:alert(1)",
    "data:text/html,hello",
    "/relative/",
  ]) {
    const blocked = prepareMessageHtml(
      `<base href="${base}"><a href="offer">Offer</a><img src="logo.png">`,
    );
    assert.notInclude(blocked.html, "<base");
    assert.include(blocked.html, 'href="offer"');
    assert.include(blocked.html, 'src="logo.png"');
    assert.isFalse(blocked.hasRemote);
  }
});

it("upgrades HTTP image alternatives and CSS while preserving cid and data images", () => {
  const result = prepareMessageHtml(
    '<img src="http://cdn.example/hero.png" srcset="http://cdn.example/small.png 1x, //cdn.example/big.png 2x"><div style="background:url(http://cdn.example/bg.png)"></div><img src="cid:bad%zz"><img src="data:image/png;base64,AAAA">',
  );
  assert.notInclude(result.html, "http:");
  assert.include(
    result.html,
    'srcset="https://cdn.example/small.png 1x, https://cdn.example/big.png 2x"',
  );
  assert.include(result.html, "background:url(https://cdn.example/bg.png)");
  assert.include(result.html, 'src="cid:bad%zz"');
  assert.include(result.html, 'src="data:image/png;base64,AAAA"');
});

it("decodes attribute entities before resolving CSS and upgrades the default HTTP port", () => {
  const result = prepareMessageHtml(
    '<base href="http://cdn.example:80/mail/"><div style="background:url(&quot;hero.png?x=1&amp;y=2&quot;)"></div>',
  );
  assert.include(result.html, "url(&quot;https://cdn.example/mail/hero.png?x=1&amp;y=2&quot;)");
  assert.notInclude(result.html, ":80");
});
