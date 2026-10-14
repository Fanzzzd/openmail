# Google OAuth client setup

OpenMail signs in to Gmail with a Google OAuth client of the Desktop app type. A source checkout has none built in. A build gets a built-in client only when it is built with `OPENMAIL_GOOGLE_CLIENT_ID` and `OPENMAIL_GOOGLE_CLIENT_SECRET` set, or with `apps/desktop/oauth-clients.local.json` present (see [release](release.md#built-in-oauth-clients)). The CLI reads the same env vars and file.

Follow this page when your build has no built-in client, or when you want to use a client from your own Google Cloud project. Without a built-in client, the add-account screen asks for your client before **Sign in with Google**. With one, open **Use your own OAuth client** on that screen. A client you enter there wins over the built-in client for new sign-ins only. Existing accounts keep the client that issued their refresh token; see [accounts and the issuing client](#accounts-and-the-issuing-client).

## Release status of the built-in client

The official built-in client belongs to the Google Cloud project `openmail-510100`. It is in **Testing**:

- Refresh tokens expire after 7 days, and the user has to sign in again. Core records the sign-in time. When a token issued by the built-in client gets `invalid_grant` at least 6.5 days after sign-in, core records the reason as `testing_mode_expiry`. The UI explains that Google currently limits OpenMail sign-ins to 7 days and asks the user to sign in again.
- Only the addresses listed under the project's **Audience → Test users** can sign in. Google rejects every other address.

Switching to **In production** without submitting for verification removes the 7-day expiry, caps the app at 100 users, and shows an "unverified app" warning on the consent page. Gmail's `gmail.modify`, `gmail.send` and `https://mail.google.com/` are restricted scopes, and full verification requires a CASA security assessment. Sources: [token expiry in Testing](https://developers.google.com/identity/protocols/oauth2#expiration), [user cap for unverified apps](https://support.google.com/cloud/answer/7454865), [restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification). The verification submission is in [google-oauth-verification.md](google-oauth-verification.md).

## Accounts and the issuing client

A refresh token works only with the client that issued it. After a successful sign-in, core writes the issuing client's client ID to `accounts.oauth_client_id` in the database (migration 43). A client ID is public, so it does not go to the keychain. A refresh uses only this client ID. Core looks for the exact same ID among the user's client, the runtime env vars and the built-in client. If none matches, the account asks for a new sign-in. Core never falls back to another client.

Accounts signed in before migration 43 have no record. Older versions issued tokens only with the client from env vars or `config.json`. So a refresh for such an account tries the env var client first, then the user's client, and never the built-in client. The first successful refresh records the client ID. If neither client exists, the account asks for a new sign-in. Deleting an account deletes the record with the account row.

The add-account screen says whether new sign-ins use the built-in client or your own. When you use your own client and the build has a built-in one, **Use the built-in client** removes your client from `config.json`. Accounts you already added keep the client they signed in with. The implementation is in [oauth-clients.ts](../packages/core/src/providers/oauth-clients.ts).

## Register your own client

1. Open <https://console.cloud.google.com/> and create a project, for example `openmail`.
2. Go to **APIs & Services → Library** and enable **Gmail API**. For the optional calendar or contacts services, also enable **Google Calendar API** or **People API**.
3. Go to **Google Auth Platform → Branding** and enter an app name and your email address. Choose **External** as the user type.
4. Go to **Audience**:
   - If the status stays at **Testing**, refresh tokens expire after 7 days and you sign in again every week.
   - Click **Publish app** to switch to **In production**. You do not need to submit for review. At sign-in Google shows an "unverified app" warning; click **Advanced → Continue**. An unverified app allows up to 100 users, which is enough for personal use.
   - If **Publish app** is greyed out with "complete your configuration on the Branding page", stay in Testing. Add every Gmail address you want to sync under **Test users**, or Google rejects the sign-in. In Testing you sign in again every 7 days.
   - To add a test user, click **Add users**, type the Gmail address in the dialog, and click **Save**. Browser scripts and CDP clicks do not reach this input, so type it by hand.
5. Under **Data Access**, add the required `gmail.modify` and `gmail.send`, with the prefix `https://www.googleapis.com/auth/`. New accounts request only these two mail scopes. Add the optional services to your project one by one, as listed in the tables below.
6. Go to **Clients → Create client**, choose **Desktop app**, and note the Client ID and Client secret.
7. Enter both values on OpenMail's add-account screen. If the build has a built-in client, they go under **Use your own OAuth client**. Or use the CLI:

   ```sh
   openmail config google --client-id <id> --client-secret <secret>
   openmail accounts add gmail
   ```

Google does not treat the secret of a Desktop app client as confidential. OpenMail stores it in `config.json` (mode 600) and stores the refresh token in the system keychain.

## Optional services

Connect services per account under **Settings → Accounts → Optional services**. Google consent still uses the client registered on this page and goes through the official consent page. The request includes the base mail scopes, the grants already recorded in the database and the scopes of the service being connected, and it sends `include_granted_scopes=true`. Core takes the new grant state from the token response. On upgrade, only old accounts with no scope record at all are recorded with the full scope set of the old version. An empty or partial record gains no scopes. Startup does not clear caches. A real 403 still returns a scoped permission error and does not pause mail sync.

A normal sign-in again, CLI `accounts reauth` and re-adding an existing account all keep every scope stored for the account, including the permanent delete scope. Google requests always send `include_granted_scopes=true`. When you re-add an account without giving the address, core first identifies the account through the official consent page. It then sends one more consent request for the identified account that keeps its stored scopes.

Turning a service off only controls local use. It does not revoke the Google grant:

| Switch         | After turning it off                                                                                          | Caches cleared                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Contacts       | Server contacts stop refreshing. Addresses from local mail still autocomplete                                 | Server contacts, contact groups, photos and the matching server autocomplete entries |
| Calendar       | Server event lookup, event creation and invite replies stop. Local invites stay readable                      | None                                                                                 |
| Gmail Settings | Creating, changing and deleting filters and changing auto-replies stop. Reading existing settings still works | None. Send-as aliases and signatures stay                                            |

`sendAs.list` works with the base `gmail.modify` scope, so alias sync does not depend on the Gmail Settings switch. [Source](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list)

| Service        | Scopes to add under Data Access                | API to enable       |
| -------------- | ---------------------------------------------- | ------------------- |
| Contacts       | `contacts.readonly`, `contacts.other.readonly` | People API          |
| Calendar       | `calendar.events`                              | Google Calendar API |
| Gmail Settings | `gmail.settings.basic`                         | Gmail API           |

All scopes use the `https://www.googleapis.com/auth/` prefix. With only `contacts.readonly`, saved contacts still work. Other contacts need the second scope. When a service is not granted or is turned off, calendar actions, auto-replies and filter changes show a prompt to connect it. Sending and receiving continue.

Clicking **Connect** on one service also requests the services the user turned on earlier and has since lost. The `enabled_json` column from migration 44 records which services the user has turned on. Services never turned on are not requested. When the request covers more services than the one clicked, OpenMail lists the others before opening the browser and continues only after the user clicks **Continue**. Signing in again and connecting a service both send `login_hint`, so Google and Microsoft preselect the account.

Google's [desktop OAuth docs](https://developers.google.com/identity/protocols/oauth2/native-app#identify-access-scopes) say that installed apps do not support incremental authorization. This implementation goes through the consent page again and lists the known grants explicitly. The parameters and local tests do not prove that a real client can add scopes without losing any. This is not yet verified against a real account. If the consent page rejects the request, check the APIs and Data Access in your own project. Keep this limit, and do not switch to another app's client.

The new features access only the user's own data:

| API                 | Endpoint and operation                                                                                                                                         | OAuth scope                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Google Calendar API | `calendars/primary/events?iCalUID=…` finds the invite; `events/{id}` PATCH sets the user's attendee `responseStatus`; `sendUpdates=all` notifies the organizer | `https://www.googleapis.com/auth/calendar.events`         |
| People API          | `people/me/connections`, `personFields=names,emailAddresses`                                                                                                   | `https://www.googleapis.com/auth/contacts.readonly`       |
| People API          | `otherContacts`, `readMask=names,emailAddresses`                                                                                                               | `https://www.googleapis.com/auth/contacts.other.readonly` |

Contacts refresh every 6 hours, and 1 hour after a failure. The old cache keeps serving autocomplete. With only `contacts.readonly`, saved contacts fill the cache, and the missing optional `contacts.other.readonly` does not block them. A hidden address is excluded from both local mail addresses and server contacts. A calendar reply goes out only after the user clicks accept, tentative or decline. When the invite is not in the calendar, add it with Google Calendar first. If an API is not enabled, enable it in the Cloud project above. Signing in again does not enable an API.

Sources: [Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events), [People connections](https://developers.google.com/people/api/rest/v1/people.connections/list), [Other contacts](https://developers.google.com/people/api/rest/v1/otherContacts/list).

Listing filters works with the existing `gmail.modify` or `gmail.readonly`. A successful empty list does not need a new sign-in. Creating or deleting a filter still needs `gmail.settings.basic`. Reading filters works with the base mail scopes, and changing them requires the Gmail Settings service. A 403 permission error only prompts to connect that service and does not change the mail sync state. Sources: [list filters](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/list), [create filter](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/create).

Code: [optional-services.ts](../packages/core/src/providers/optional-services.ts) defines the base and per-service scopes. [store-services.ts](../packages/core/src/store/store-services.ts) handles grant records of old accounts. [mailbox-services.ts](../packages/core/src/mailbox/mailbox-services.ts) turns services on and off locally. Official consent and token response handling are in [mailbox-live.ts](../packages/core/src/mailbox/mailbox-live.ts), [Node OAuth](../packages/core/src/platform/node/oauth.ts) and [mobile OAuth](../packages/core/src/platform/react-native/oauth.ts). Migration 33 stores only the local switches, never credentials. Scoped permission errors and redacted logs are covered in the [security notes](security.md#provider-diagnostics).

## Permanent delete permission

Gmail's `gmail.modify` does not allow permanent deletion. To delete permanently or empty Trash from the app, add `https://mail.google.com/` under **Data Access** in your own project. Then sign in again from the app's permanent delete permission prompt. Core requests this scope only in that feature's consent flow and checks the scopes Google actually granted. Normal sign-in, sending and receiving request only the base mail scopes. A missing permission does not stop normal sync. CLI `accounts reauth` does not add this scope. A permanent delete scope already stored stays through a normal sign-in again.

Source: [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Mobile

The mobile app needs new iOS and Android clients. It does not use the Desktop client ID or secret. First set up the project, APIs, Audience and Data Access on this page. Then set the env vars that `apps/mobile/app.config.ts` reads.

1. Decide your app's bundle ID and package name, and set `OPENMAIL_IOS_BUNDLE_ID` and `OPENMAIL_ANDROID_PACKAGE`. Both default to `com.openmail.mobile`.
2. In **Google Auth Platform → Clients → Create client**, choose **iOS** and enter the same Bundle ID. Set the client ID as `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`. If the console asks for an App Store ID or Team ID, enter your own app and Apple team details.
3. Create an **Android** client with the same Package name and the SHA-1 of your own signing certificate. The development, release and Play App Signing certificates can differ. Create a client that matches the package and certificate you actually use. `keytool -list -v -keystore <keystore>` shows the SHA-1 of your keystore.
4. Set the Android client ID as `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`. The mobile app uses the AuthSession system browser flow, so enable the custom scheme under **Advanced Settings → Custom URI scheme** on that Android client. Google disables it by default and recommends native Google Identity Services. If the console does not let you enable it, the current browser flow cannot use that client, and the native SDK has to come first. Do not substitute the iOS or Desktop client ID.
5. Both platforms derive the callback from their client ID: `123.apps.googleusercontent.com` maps to `com.googleusercontent.apps.123:/oauthredirect`. The Expo config registers the scheme. After a client ID change, rebuild and reinstall the development build. Expo Go does not support this callback.
6. The add Gmail account button opens the official consent page. AuthSession sends the authorization code, PKCE S256 and state, and core exchanges the token. The mobile client sends no client secret. The refresh token goes only to expo-secure-store.

The mobile consent flow is wired up but still needs verification with a real account. Normal sign-in uses the same base mail scopes as the desktop app. Optional services are connected per account on the desktop.

Sources: [register Android and iOS clients and Advanced Settings](https://support.google.com/googleapi/answer/6158849?hl=en), [Google custom URI restrictions and how to enable them](https://developers.googleblog.com/improving-user-safety-in-oauth-flows-through-new-oauth-custom-uri-scheme-restrictions/), [native OAuth with PKCE](https://developers.google.com/identity/protocols/oauth2/native-app).
