import { Schema } from "effect";

/**
 * IMAP/SMTP providers that sign in with an app-specific password. The
 * password goes to the keychain (secrets.ts); host settings go to
 * accounts.settings_json.
 */
export const ImapPreset = Schema.Struct({
  name: Schema.String,
  imapHost: Schema.String,
  imapPort: Schema.Int,
  smtpHost: Schema.String,
  smtpPort: Schema.Int,
  smtpSecure: Schema.Boolean,
  /** Where the user creates an app-specific password. */
  appPasswordUrl: Schema.optionalKey(Schema.String),
  /** One line shown under the password field. */
  note: Schema.optionalKey(Schema.String),
  /**
   * The SMTP server files a copy of every sent message in Sent by itself.
   * `send` then waits briefly for that copy before appending its own, so
   * Sent does not get two. Either way it appends when no copy shows up.
   */
  serverSavesSent: Schema.optionalKey(Schema.Boolean),
});
export type ImapPreset = typeof ImapPreset.Type;

// Hosts and ports come from each provider's help pages:
// iCloud  support.apple.com/102525
// Yahoo   help.yahoo.com/kb/SLN4075.html
// QQ      help.mail.qq.com/detail/106/985, service.mail.qq.com/detail/0/427
// 163     help.mail.163.com (如何开启客户端协议), mail.163.com/mailhelp/client.htm
// Fastmail fastmail.help/hc/en-us/articles/1500000278342
export const IMAP_PRESETS: Record<string, ImapPreset> = {
  icloud: {
    name: "iCloud",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false,
    appPasswordUrl: "https://account.apple.com/account/manage",
    note: "在 Apple 账户的「登录与安全」里生成 App 专用密码。",
    serverSavesSent: true,
  },
  yahoo: {
    name: "Yahoo",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: "https://login.yahoo.com/account/security",
    note: "在 Yahoo 账户的「账户安全」里生成应用密码。",
    serverSavesSent: true,
  },
  qq: {
    name: "QQ 邮箱",
    imapHost: "imap.qq.com",
    imapPort: 993,
    smtpHost: "smtp.qq.com",
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: "https://mail.qq.com/",
    note: "在网页版「设置 > 账号与安全 > 安全设置」开启 IMAP/SMTP 服务，再生成授权码。",
    // Only when「SMTP发信后保存到服务器」is on; send appends when it is off.
    serverSavesSent: true,
  },
  "163": {
    name: "163 邮箱",
    imapHost: "imap.163.com",
    imapPort: 993,
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: "https://mail.163.com/",
    note: "在网页版「设置 > POP3/SMTP/IMAP」开启 IMAP 服务，按提示生成授权码。",
    serverSavesSent: true,
  },
  fastmail: {
    name: "Fastmail",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecure: true,
    appPasswordUrl: "https://app.fastmail.com/settings/security/apps",
    note: "在「设置 > 隐私与安全」里新建应用密码，勾选 IMAP 和 SMTP。",
    serverSavesSent: false,
  },
};

export const ImapConnectInput = Schema.Struct({
  /** Key into IMAP_PRESETS, or "custom". */
  preset: Schema.String,
  email: Schema.String,
  /** Defaults to the email address. */
  username: Schema.optionalKey(Schema.String),
  password: Schema.String,
  /** Required for "custom"; overrides the preset otherwise. */
  imapHost: Schema.optionalKey(Schema.String),
  imapPort: Schema.optionalKey(Schema.Int),
  smtpHost: Schema.optionalKey(Schema.String),
  smtpPort: Schema.optionalKey(Schema.Int),
  smtpSecure: Schema.optionalKey(Schema.Boolean),
});
export type ImapConnectInput = typeof ImapConnectInput.Type;
