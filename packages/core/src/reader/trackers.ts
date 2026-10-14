/**
 * Mail tracking services: the hosts their open pixels load from, and below
 * them the open-pixel paths they use on senders' own domains. The reader
 * strips these URLs from every message, even when remote images are allowed,
 * so opening a message never tells the sender it was read.
 *
 * A host matches itself and its subdomains. `path` narrows a host that also
 * serves real content (images, pages) to its tracking endpoints. Plain data
 * with no Node dependencies; exported through `@openmail/core/schema`.
 */
import { webUrl } from "./resource-url.js";

export interface Tracker {
  readonly name: string;
  readonly hosts: readonly (string | RegExp)[];
  readonly path?: RegExp;
}

/** Paths that open pixels commonly use, for hosts that also serve other things. */
const OPEN = /open|track|pixel|beacon|\/o\/|\/e\/o\b/i;

export const TRACKERS: readonly Tracker[] = [
  // Newsletter and marketing platforms
  { name: "Mailchimp", hosts: ["list-manage.com"], path: /\/track\/open/i },
  { name: "Mandrill", hosts: ["mandrillapp.com"], path: /\/track\/open/i },
  { name: "SendGrid", hosts: ["sendgrid.net", "sendgrid.com"], path: /\/wf\/open|\/trk/i },
  { name: "Mailgun", hosts: ["mailgun.org", "mailgun.net"], path: /\/o\//i },
  { name: "Mailjet", hosts: ["mjt.lu"], path: /\/oo\//i },
  { name: "Amazon SES", hosts: ["awstrack.me"], path: /\/I0\//i },
  { name: "Postmark", hosts: ["pstmrk.it"] },
  { name: "SparkPost", hosts: ["sparkpostmail.com", "spgo.io"], path: /\/q\/|open/i },
  { name: "Brevo", hosts: [/(^|\.)sendib[tw]\d*\.com$/i, "brevo.com"], path: /\/tr\/op|open/i },
  { name: "Constant Contact", hosts: ["rs6.net"], path: /\/on\.jsp/i },
  { name: "Campaign Monitor", hosts: [/(^|\.)cmail\d+\.com$/i, "createsend.com"], path: /\/t\//i },
  { name: "AWeber", hosts: ["openrate.aweber.com"] },
  { name: "GetResponse", hosts: ["getresponse.com", "getresponse360.com", "gr8.com"], path: OPEN },
  {
    name: "ActiveCampaign",
    hosts: ["acemlna.com", "acemlnb.com", "acemlnc.com", "acemlnd.com", "activehosted.com"],
    path: /lt\.php|open/i,
  },
  { name: "Drip", hosts: ["getdrip.com", "drip.com"], path: OPEN },
  { name: "MailerLite", hosts: ["mlsend.com", "mailerlite.com"], path: OPEN },
  { name: "ConvertKit", hosts: [/(^|\.)open\.convertkit-mail\d*\.com$/i] },
  { name: "Substack", hosts: ["eotrx.substackcdn.com", "substack.com"], path: /\/o\/|open/i },
  { name: "beehiiv", hosts: ["beehiiv.com"], path: /\/o\/|open/i },
  { name: "Buttondown", hosts: ["buttondown.email", "buttondown.com"], path: OPEN },
  { name: "Ghost", hosts: ["ghost.io"], path: /\/o\/|open/i },
  { name: "Klaviyo", hosts: ["klaviyomail.com", "trk.klaviyo.com", /(^|\.)klclick\d*\.com$/i] },
  { name: "Omnisend", hosts: ["omnisend.com", "omnisrc.com"], path: OPEN },
  { name: "Moosend", hosts: ["moosend.com", "moosend-mail.com"], path: OPEN },
  { name: "SendPulse", hosts: ["stat-pulse.com"] },
  { name: "Benchmark Email", hosts: ["bmetrack.com"] },
  { name: "iContact", hosts: ["icptrack.com"] },
  { name: "VerticalResponse", hosts: ["vresp.com"] },
  { name: "Emma", hosts: ["t.e2ma.net"] },
  { name: "EmailOctopus", hosts: ["emailoctopus.com", "eomail1.com", "eomail2.com"], path: OPEN },
  {
    name: "Zoho Campaigns",
    hosts: ["maillist-manage.com", "maillist-manage.eu", "zohocampaigns.com"],
  },
  { name: "Keap", hosts: ["infusionsoft.com", "keap.com"], path: /emailOpened|open/i },
  { name: "Ontraport", hosts: ["ontraport.com", "ontraport.net"], path: OPEN },
  { name: "Mailmodo", hosts: ["mailmodo.com"], path: OPEN },
  { name: "Encharge", hosts: ["encharge.io"], path: OPEN },
  { name: "Loops", hosts: ["loops.so"], path: OPEN },
  { name: "Litmus", hosts: ["emltrk.com"] },

  // Customer messaging and product analytics
  {
    name: "HubSpot",
    hosts: ["hubspotemail.net", "hubspotfree.net", "track.hubspot.com", "hubspotlinks.com"],
  },
  { name: "HubSpot Sales", hosts: [/(^|\.)sidekickopen\d*\.com$/i, "hubspotstarter.net"] },
  { name: "Customer.io", hosts: ["track.customer.io", "customeriomail.com"] },
  { name: "Intercom", hosts: ["intercom-mail.com", "via.intercom.io"] },
  { name: "Braze", hosts: ["appboy.com", "braze.com", "braze.eu"], path: OPEN },
  { name: "Iterable", hosts: ["links.iterable.com"] },
  { name: "Vero", hosts: ["tracking.getvero.com"] },
  { name: "Autopilot", hosts: ["autopilothq.com", "autopilotmail.io"], path: OPEN },
  { name: "Mixpanel", hosts: ["mixpanel.com"], path: /track|engage/i },
  { name: "Segment", hosts: ["api.segment.io"] },
  { name: "Amplitude", hosts: ["api.amplitude.com", "api2.amplitude.com"] },
  { name: "Heap", hosts: ["heapanalytics.com"] },
  { name: "Pendo", hosts: ["pendo.io"], path: /\/data\/|ptm|track/i },
  { name: "Google Analytics", hosts: ["google-analytics.com", "analytics.google.com"] },
  { name: "Facebook", hosts: ["facebook.com"], path: /^\/tr\b|^\/email_open_log_pic\.php/i },
  { name: "LinkedIn", hosts: ["linkedin.com"], path: /\/emimp\//i },
  { name: "Medium", hosts: ["medium.com"], path: /\/_\/stat/i },
  { name: "Quora", hosts: ["quora.com"], path: /mark_read|email_track/i },

  // Enterprise marketing clouds
  { name: "Marketo", hosts: ["mktoedge.com", "mktoresp.com", "marketo.com"], path: /trk|open/i },
  { name: "Salesforce Pardot", hosts: ["pardot.com"] },
  { name: "Salesforce Marketing Cloud", hosts: ["exct.net", "exacttarget.com"], path: /open/i },
  { name: "Oracle Eloqua", hosts: ["en25.com", "eloqua.com"] },
  { name: "Oracle Responsys", hosts: [/(^|\.)rsys\d+\.net$/i, "responsys.net"] },
  { name: "Adobe Campaign", hosts: ["neolane.net", "campaign.adobe.com"] },
  { name: "Acoustic", hosts: [/(^|\.)mkt\d+\.(com|net)$/i, "silverpop.com"] },
  { name: "Sailthru", hosts: ["sailthru.com"], path: /trk|open/i },
  { name: "Emarsys", hosts: ["emarsys.net"] },
  { name: "Cheetah Digital", hosts: ["chtah.com", "chtah.net"] },
  { name: "Bronto", hosts: ["bm23.com", "bronto.com"] },
  { name: "Listrak", hosts: ["listrakbi.com"] },
  { name: "Dotdigital", hosts: ["dmtrk.net", "trackedlink.net"] },
  { name: "Cordial", hosts: ["crdl.io"] },
  { name: "Attentive", hosts: ["attn.tv"] },

  // Sales engagement and personal read receipts
  { name: "Superhuman", hosts: ["r.superhuman.com"] },
  { name: "Mailtrack", hosts: ["mailtrack.io", "mailsuite.com"] },
  { name: "Streak", hosts: ["mailfoogae.appspot.com", "streak.com"], path: /track|\/t\b/i },
  { name: "Yesware", hosts: ["t.yesware.com", "yesware.com"], path: /\/t\/|track/i },
  { name: "Mixmax", hosts: ["track.mixmax.com", "email.mixmax.com"] },
  { name: "Hunter", hosts: ["mltrk.io"] },
  { name: "Mailshake", hosts: ["mailshake.com"], path: OPEN },
  { name: "lemlist", hosts: ["lemlist.com"], path: OPEN },
  { name: "Reply.io", hosts: ["reply.io"], path: OPEN },
  { name: "Woodpecker", hosts: ["woodpecker.co"], path: OPEN },
  { name: "GMass", hosts: ["gmass.co"] },
  { name: "Salesloft", hosts: ["salesloft.com"], path: OPEN },
  { name: "Outreach", hosts: ["outrch.com", "outreach.io"], path: OPEN },
  { name: "Apollo", hosts: ["aplo-evnt.com", "apollo.io"], path: OPEN },
  { name: "Klenty", hosts: ["klenty.com"], path: OPEN },
  { name: "Snov.io", hosts: ["snov.io"], path: OPEN },
  { name: "SalesHandy", hosts: ["saleshandy.com"], path: OPEN },
  { name: "Gong", hosts: ["gong.io"], path: OPEN },
  { name: "Close", hosts: ["close.com", "close.io"], path: OPEN },
  { name: "Pipedrive", hosts: ["pipedrive.com"], path: OPEN },
  { name: "Salesforce Inbox", hosts: ["toutapp.com"] },
  { name: "Cirrus Insight", hosts: ["cirrusinsight.com"] },
  { name: "ContactMonkey", hosts: ["contactmonkey.com"] },
  { name: "Mailbutler", hosts: ["mailbutler.io"] },
  { name: "Boomerang", hosts: ["mailstat.us"] },
  { name: "Bananatag", hosts: ["bl-1.com"] },
  { name: "Right Inbox", hosts: ["rightinbox.com"], path: OPEN },
  { name: "Polymail", hosts: ["polymail.io"], path: /\/z\/|track|open/i },
  { name: "Front", hosts: ["app.frontapp.com"], path: OPEN },
  { name: "Mailspring", hosts: ["getmailspring.com"], path: /open/i },
];

/**
 * Open pixels a sender serves from its own branded tracking domain, such as
 * `links.example.com` set up as a CNAME to the service. The host says nothing,
 * so these match the path and query, and only shapes no ordinary image has:
 * each needs the service's own token format, not just a short path like `/o/`.
 */
export interface TrackingPath {
  readonly name: string;
  /** Matched against the decoded path and query, starting at `/`. */
  readonly path: RegExp;
  /** Narrows a shape that is distinctive only on the service's usual host name. */
  readonly host?: RegExp;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

export const TRACKING_PATHS: readonly TrackingPath[] = [
  // SendGrid link branding: /wf/open?upn=<token>
  { name: "SendGrid", path: /^\/wf\/open\?(?:[^#]*&)?upn=/i },
  // Salesforce Marketing Cloud: open.aspx with an ffcb10- token, or a newer token with bmt=0
  { name: "Salesforce Marketing Cloud", path: /^\/open\.aspx\?(?:ffcb10-|[^#]*&bmt=0(?:&|$))/i },
  // Mailgun: /o/ and a zlib+base64url token (eJ...); on its default email.* host any token
  { name: "Mailgun", path: /^\/o\/eJ[\w-]{16,}/ },
  { name: "Mailgun", host: /^email\./i, path: /^\/o\/[\w.~=-]+$/ },
  // Mailchimp and Mandrill on a custom domain: /track/open.php?u=<user>&id=<hex> or ?p=<token>
  { name: "Mailchimp", path: /^\/track\/open\.php\?(?:u=\d+&id=[0-9a-f]{10}|p=)/i },
  // HubSpot marketing (/e3t/Cto/) and sales (/e1t/o/<n>/)
  { name: "HubSpot", path: /^\/e3t\/[BC]to\/|^\/e1t\/o\/\d+\// },
  // Amazon SES custom open domain: /CI0/<SES message id>/<token>
  {
    name: "Amazon SES",
    path: /^\/CI0\/[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-0{6}\//,
  },
  // Customer.io: /e/o/<base64 JSON, so eyJ...>
  { name: "Customer.io", path: /^\/e\/o\/eyJ[\w=-]{8,}/ },
  // Klaviyo: /o/<ULID>
  { name: "Klaviyo", path: /^\/o\/01[0-9A-HJKMNP-TV-Z]{24}$/ },
  // Iterable: /e/eo?_t=<hex>&_m=<hex>
  { name: "Iterable", path: /^\/e\/eo\?_t=[0-9a-f]{32}&/i },
  // SparkPost: /q/<token>~~/<token>~/
  { name: "SparkPost", path: /^\/q\/[\w-]+~~\/[\w-]+~\// },
  // Brevo: /tr/op/<long token>
  { name: "Brevo", path: /^\/tr\/op\/[\w-]{40,}/ },
  // Mailjet: /oo/<id>/<8 chars>/e.gif
  { name: "Mailjet", path: /^\/oo\/[a-z0-9]+\/[a-z0-9]{8}\/e\.gif$/i },
];

const hostMatches = (host: string, pattern: string | RegExp) =>
  typeof pattern === "string"
    ? host === pattern || host.endsWith(`.${pattern}`)
    : pattern.test(host);

/** Decodes valid `%XX` escapes byte by byte; malformed escapes stay as written. */
const percentDecode = (value: string) =>
  value.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );

/**
 * The path and query a server may act on: percent-decoded until stable (at
 * most three rounds), backslashes read as slashes, and `.`/`..` segments that
 * decoding exposed resolved again.
 */
function trackingPath(url: URL): string {
  let path = `${url.pathname}${url.search}`;
  for (let round = 0; round < 3; round++) {
    const decoded = percentDecode(path);
    if (decoded === path) break;
    path = decoded;
  }
  const query = path.indexOf("?");
  const segments: string[] = [];
  for (const segment of (query < 0 ? path : path.slice(0, query))
    .replaceAll("\\", "/")
    .split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== ".") segments.push(segment);
  }
  const resolved = segments.join("/");
  return `${resolved.startsWith("/") ? "" : "/"}${resolved}${query < 0 ? "" : path.slice(query)}`;
}

/** The tracking service a parsed http(s) URL belongs to, or undefined. */
export function trackerForUrl(url: URL): string | undefined {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const path = trackingPath(url);
  for (const tracker of TRACKERS) {
    if (!tracker.hosts.some((h) => hostMatches(host, h))) continue;
    if (tracker.path && !tracker.path.test(path)) continue;
    return tracker.name;
  }
  for (const tracker of TRACKING_PATHS) {
    if (tracker.host && (!tracker.host.test(host) || IMAGE_FILE.test(path))) continue;
    if (tracker.path.test(path)) return tracker.name;
  }
  return undefined;
}

/**
 * The tracking service a URL belongs to, or undefined. Only http(s) and
 * protocol-relative URLs match, read as a browser reads them (see `webUrl`).
 */
export function trackerFor(url: string): string | undefined {
  const parsed = webUrl(url.replaceAll("&amp;", "&"));
  return parsed && trackerForUrl(parsed);
}
