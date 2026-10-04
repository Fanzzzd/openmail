import { ImapFlow } from "imapflow";

export function fakeImapClient(
  options: ConstructorParameters<typeof ImapFlow>[0] = {
    host: "fake.invalid",
    port: 993,
    logger: false,
  },
) {
  return new ImapFlow(options);
}
