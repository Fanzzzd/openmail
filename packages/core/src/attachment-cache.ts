/** Per-mailbox byte LRU. Copies prevent a tiny MIME slice pinning a whole message. */
export class AttachmentCache {
  private readonly messages = new Map<string, Map<string, Uint8Array>>();
  private bytes = 0;
  constructor(
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly messageBytes = 8 * 1024 * 1024,
    private readonly maxMessages = 8,
  ) {}
  get(id: string, key: string) {
    const message = this.messages.get(id);
    const data = message?.get(key);
    if (!message || !data) return null;
    this.messages.delete(id);
    this.messages.set(id, message);
    message.delete(key);
    message.set(key, data);
    return data;
  }
  set(id: string, key: string, input: Uint8Array) {
    if (input.byteLength > this.messageBytes || input.byteLength > this.maxBytes) return;
    let message = this.messages.get(id);
    if (!message) {
      message = new Map();
      this.messages.set(id, message);
    }
    const previous = message.get(key);
    if (previous) this.bytes -= previous.byteLength;
    message.delete(key);
    const data = new Uint8Array(input);
    message.set(key, data);
    this.bytes += data.byteLength;
    const size = () => Array.from(message.values()).reduce((n, file) => n + file.byteLength, 0);
    while (size() > this.messageBytes || message.size > 16) {
      const oldest = message.keys().next();
      if (oldest.done) break;
      const file = message.get(oldest.value);
      if (file) this.bytes -= file.byteLength;
      message.delete(oldest.value);
    }
    this.messages.delete(id);
    this.messages.set(id, message);
    while (this.bytes > this.maxBytes || this.messages.size > this.maxMessages) {
      const oldest = this.messages.entries().next();
      if (oldest.done) break;
      this.bytes -= Array.from(oldest.value[1].values()).reduce(
        (n, file) => n + file.byteLength,
        0,
      );
      this.messages.delete(oldest.value[0]);
    }
  }
}
