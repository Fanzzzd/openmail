/**
 * Mail tracking services: the hosts their open pixels load from. The reader
 * strips these URLs from every message, even when remote images are allowed,
 * so opening a message never tells the sender it was read.
 *
 * A host matches itself and its subdomains. `path` narrows a host that also
 * serves real content (images, pages) to its tracking endpoints. Plain data
 * with no Node dependencies; exported through `@openmail/core/schema`.
 */
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
  { name: "Klaviyo", hosts: ["klaviyomail.com", "trk.klaviyo.com"] },
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
  { name: "Facebook", hosts: ["facebook.com"], path: /^\/tr\b/i },
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

const hostMatches = (host: string, pattern: string | RegExp) =>
  typeof pattern === "string"
    ? host === pattern || host.endsWith(`.${pattern}`)
    : pattern.test(host);

/** The tracking service a URL belongs to, or undefined. Only http(s) and protocol-relative URLs match. */
export function trackerFor(url: string): string | undefined {
  const trimmed = url.trim().replaceAll("&amp;", "&");
  if (!/^(https?:)?\/\//i.test(trimmed)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const path = `${parsed.pathname}${parsed.search}`;
  for (const tracker of TRACKERS) {
    if (!tracker.hosts.some((h) => hostMatches(host, h))) continue;
    if (tracker.path && !tracker.path.test(path)) continue;
    return tracker.name;
  }
  return undefined;
}
