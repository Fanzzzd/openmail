type Milliseconds = number | (() => number);

export interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
}

export interface CdpClient {
  socket: WebSocket;
  send(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: Milliseconds },
  ): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(): Promise<Uint8Array>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  close(): void;
}

export function listTargets(
  port: number,
  options?: { timeoutMs?: Milliseconds },
): Promise<CdpTarget[]>;

export function connectCdp(
  url: string,
  options?: {
    connectTimeoutMs?: Milliseconds;
    callTimeoutMs?: Milliseconds;
    closeReason?: () => string;
  },
): Promise<CdpClient>;
