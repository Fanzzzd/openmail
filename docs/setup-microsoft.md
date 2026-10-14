# Microsoft (Azure) OAuth client setup

OpenMail signs in to personal outlook.com accounts through Microsoft Graph with an Azure public client: the `consumers` tenant, an `http://localhost` redirect and no secret. A source checkout has none built in. A build gets a built-in client only when it is built with `OPENMAIL_MICROSOFT_CLIENT_ID` set, or with `apps/desktop/oauth-clients.local.json` present (see [release](release.md#built-in-oauth-clients)). The CLI reads the same env var and file.

Follow this page when your build has no built-in client, or when you want to use an app you registered in Azure yourself. Without a built-in client, the add-account screen asks for your client ID before **Sign in with Microsoft**. With one, open **Use your own OAuth client** on that screen. A client ID you enter there wins over the built-in client for new sign-ins only. Existing accounts keep the client that issued their refresh token; the rules are on the [Google page](setup-google.md#accounts-and-the-issuing-client). Credentials stay on your Mac.

> Only personal accounts (outlook.com, hotmail, live) are supported. Work or school Microsoft 365 accounts need a tenant admin to approve the app first, and OpenMail does not bypass that step.

## Register your own app

0. A personal account needs an Entra directory first. Microsoft no longer allows app registration outside a directory, and the App registrations page says "The ability to create applications outside of a directory has been deprecated". Signing up for a free Azure account (<https://azure.microsoft.com/free>) creates a Default Directory. It needs a credit card and a phone number for a pre-authorization only, and nothing is charged unless you upgrade. If you submit the address page of the sign-up from a browser with a debugging port open, Microsoft returns "unexpected error". Submit it from your everyday browser instead.
1. Open <https://portal.azure.com/> and go to **Microsoft Entra ID → App registrations → New registration**.
2. Enter `openmail` as the Name. Under **Supported account types**, choose **Personal Microsoft accounts only**.
3. Under **Redirect URI**, choose the platform **Public client/native (mobile & desktop)** and enter `http://localhost`.
   - Azure's text box rejects `http://127.0.0.1`. `http://localhost` matches any loopback port, so the callback works whichever port the sign-in uses. OpenMail's loopback server still binds `127.0.0.1`.
4. After registering, note the **Application (client) ID** on the **Overview** page.
5. Go to **API permissions → Add a permission → Microsoft Graph → Delegated** and add the required `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access` and `MailboxSettings.ReadWrite`. New accounts request only this base set. `MailboxSettings.ReadWrite` is needed to manage masterCategories, and categories are part of the base mail label feature. Add the optional services as listed in the tables below. Personal accounts need no admin consent.
6. Go to **Authentication** and check that **Allow public client flows** is on. A public client uses PKCE, not a secret.
7. Enter the client ID on OpenMail's add-account screen. If the build has a built-in client, it goes under **Use your own OAuth client**. Or use the CLI:

   ```sh
   openmail config microsoft --client-id <application-client-id>
   openmail accounts add outlook
   ```

A public client has no secret. The client ID is stored in `config.json` (mode 600), and the refresh token in the system keychain.

## Optional services

Connect services one by one under **Settings → Accounts → Optional services**. Consent uses only the account's issuing client, either a built-in client or one you registered, and Microsoft's official `consumers` consent page. The request keeps the known grants and adds the scopes of the service being connected. Core records the new grants from the token response. On upgrade, old Outlook accounts with no scope record at all are recorded with the full scope set of the old version, and their contact and alias caches stay. An empty or partial record gains no scopes. Startup does not clear caches, and a real 403 is still handled as an error for that feature only. A normal sign-in again and re-adding an existing account both request every scope stored for the account. When you re-add an account without giving the address, core first identifies the account. It then sends one more official consent request for the existing account that keeps its stored scopes.

Turning a service off only controls local use. It does not revoke the Microsoft grant:

| Switch          | After turning it off                                                                               | Caches cleared                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Contacts        | Server contacts stop refreshing. Addresses from local mail still autocomplete                      | Server contacts, groups, photos and the matching server autocomplete entries |
| Calendar        | Server event lookup, event creation and invite replies stop                                        | None                                                                         |
| MailboxSettings | Changes to server rules and auto-replies stop. Category management and reading settings still work | None                                                                         |

`MailboxSettings.ReadWrite` stays in the base scopes because listing and registering masterCategories needs it. The MailboxSettings switch only controls changes to optional settings. [Source](https://learn.microsoft.com/en-us/graph/api/outlookuser-list-mastercategories?view=graph-rest-1.0)

| Service         | Permissions to add under API permissions → Microsoft Graph → Delegated |
| --------------- | ---------------------------------------------------------------------- |
| Contacts        | `Contacts.Read`, `People.Read`                                         |
| Calendar        | `Calendars.ReadWrite`                                                  |
| MailboxSettings | `MailboxSettings.ReadWrite`, already part of the base permissions      |

`Contacts.Read` covers saved contacts and `People.Read` covers people suggestions. The current refresh queries both. If one request lacks permission, that refresh fails and the existing cache stays. When a service is not granted or is turned off, its features prompt to connect it, and mail keeps syncing. The real consent page and partial grant results are not yet tested.

Source: [Microsoft incremental consent and scopes](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc).

The new features use delegated permissions on Microsoft Graph v1.0:

| Endpoint and operation                                                                                                                                                 | OAuth scope                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `/me/messages/{id}?$expand=microsoft.graph.eventMessage/event` finds the linked event; a plain `.ics` attachment is looked up with `/me/events?$filter=iCalUId eq '…'` | `Mail.ReadWrite`, `Calendars.ReadWrite` |
| `/me/events/{id}/accept`, `tentativelyAccept`, `decline`, POST with `sendResponse: true`                                                                               | `Calendars.ReadWrite`                   |
| Contacts in `/me/contacts` and in root and nested `contactFolders`, reading `displayName,emailAddresses,companyName`                                                   | `Contacts.Read`                         |
| `/me/people`, reading `displayName,scoredEmailAddresses`                                                                                                               | `People.Read`                           |

A contacts refresh walks the default contacts, every root contact folder and their child folders recursively. Each collection follows nextLink pages. Core removes duplicates by contact ID and then merges the email addresses. `/me/people` is a relevance-ranked suggestion feed. Core takes only the first batch of up to 250 people, does not treat it as a full contact list, and does not follow its nextLink. The implementation is in [outlook-features.ts](../packages/core/src/providers/outlook/outlook-features.ts), pagination link validation is described in [architecture](architecture.md#providers-and-store), and the regression tests are in [outlook-services.test.ts](../packages/core/src/providers/outlook/outlook-services.test.ts).

When an existing grant lacks a new scope, the feature prompts to connect the optional service, and mail sync continues. Contacts refresh every 6 hours, and 1 hour after a failure. The old cache keeps serving autocomplete. Only a user click sends a calendar reply. All consent and refreshes still go through `https://login.microsoftonline.com/consumers`, never a work tenant.

Sources: [accept event](https://learn.microsoft.com/en-us/graph/api/event-accept?view=graph-rest-1.0), [linked meeting message](https://learn.microsoft.com/en-us/graph/api/eventmessage-get?view=graph-rest-1.0), [Contacts](https://learn.microsoft.com/en-us/graph/api/user-list-contacts?view=graph-rest-1.0), [People](https://learn.microsoft.com/en-us/graph/api/user-list-people?view=graph-rest-1.0).

Code: [optional-services.ts](../packages/core/src/providers/optional-services.ts) defines the base and per-service scopes. [store-services.ts](../packages/core/src/store/store-services.ts) handles grant records of old accounts. [mailbox-services.ts](../packages/core/src/mailbox/mailbox-services.ts) turns services on and off locally. Official consent and token response handling are in [mailbox-live.ts](../packages/core/src/mailbox/mailbox-live.ts), [Node OAuth](../packages/core/src/platform/node/oauth.ts) and [mobile OAuth](../packages/core/src/platform/react-native/oauth.ts). Migration 33 stores only the local switches, never credentials. Scoped permission errors and redacted logs are covered in the [security notes](security.md#provider-diagnostics).

## Mobile

Add native platform callbacks to the public app you registered. Do not borrow another app's client ID. The mobile app needs no secret, and consent and refresh go only through `consumers`.

1. Create the app as described on this page, and keep Supported account types at **Personal Microsoft accounts only**. Set your Application (client) ID as `EXPO_PUBLIC_MICROSOFT_CLIENT_ID`. Both mobile platforms can go on the same app registration.
2. Decide `OPENMAIL_IOS_BUNDLE_ID` and `OPENMAIL_ANDROID_PACKAGE`. Both default to `com.openmail.mobile`.
3. Under **Authentication → Add a platform → iOS/macOS**, enter the same Bundle ID. Register the callback `msauth.<bundle-id>://auth`. `app.config.ts` registers the scheme, and iOS uses this full URI.
4. Under **Add a platform → Android**, enter the same Package name and your own signature hash. Run the command below against the certificate you actually build with to get the Base64 SHA-1, and enter it as the Signature hash in the console. If the development and release certificates differ, register each.

   ```sh
   keytool -exportcert -alias <alias> -keystore <keystore> | openssl sha1 -binary | openssl base64
   ```

5. Copy the full Android redirect URI the console generates, usually `msauth://<package-name>/<URL-encoded-signature-hash>`, and set it as `EXPO_PUBLIC_MICROSOFT_ANDROID_REDIRECT`. Do not re-encode the `+`, `/` or `=` of the Base64 hash by hand. The Expo Android intent filter uses the package as host and the path of this URI, so the system browser returns to this app. There is no MSAL broker.
6. Keep **Allow public client flows** on, and use the delegated permissions listed on this page. PKCE does not need the implicit grant. After changing a callback or env var, rebuild and reinstall the development build. Expo Go does not work here.
7. Tap add Outlook account to open Microsoft's official consent page for personal accounts. AuthSession checks the state. Core exchanges the token with the same redirect URI and PKCE verifier. The refresh token goes only to expo-secure-store.

The mobile consent flow still needs verification with a real account. Work and school M365 tenants remain unsupported. The desktop loopback URI does not change, and normal sign-in requests only the base mail scopes.

Sources: [Microsoft mobile platform configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-mobile-app-configuration), [Android redirect URI](https://learn.microsoft.com/en-us/entra/msal/android/frequently-asked-questions), [Expo native callbacks](https://docs.expo.dev/guides/authentication/).
