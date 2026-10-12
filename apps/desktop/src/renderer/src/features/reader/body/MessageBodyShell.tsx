import { useLingui } from "@lingui/react/macro";
import { Component, type ComponentProps, type ReactNode, useSyncExternalStore } from "react";

// The message body, EmailFrame and core's HTML cleaner load in a lazy chunk
// (MessageBody.tsx), so the list paints before ~0.8 MB of parser code runs.
// The loader and what the reader shows until the chunk arrives live here, in the entry.

type MessageBodyModule = typeof import("./MessageBody");

let loaded: MessageBodyModule | Error | null = null;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** Starts loading the body chunk once; resolves when it has loaded or failed. */
export function loadMessageBody(): Promise<void> {
  loading ??= (async () => {
    try {
      loaded = await import("./MessageBody");
    } catch (error) {
      loaded = error instanceof Error ? error : new Error(String(error));
      // A failed load is not cached, so Retry imports again.
      loading = undefined;
    }
    for (const notify of listeners) notify();
  })();
  return loading;
}

/** Clears a failed load and starts another. */
export function retryMessageBody(): void {
  if (loaded instanceof Error) loaded = null;
  void loadMessageBody();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (loaded === null) void loadMessageBody();
  return () => listeners.delete(listener);
}

/** The body chunk, the error of a failed load, or null while it loads. */
export function useMessageBodyState(): MessageBodyModule | Error | null {
  return useSyncExternalStore(subscribe, () => loaded);
}

/** The body chunk, or null while it loads. A failed load throws to MessageBodyBoundary. */
function useMessageBody(): MessageBodyModule | null {
  const module = useMessageBodyState();
  if (module instanceof Error) throw module;
  return module;
}

class MessageBodyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  retry = () => {
    retryMessageBody();
    this.setState({ failed: false });
  };
  override render() {
    return this.state.failed ? <BodyFailed onRetry={this.retry} /> : this.props.children;
  }
}

function BodyFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useLingui();
  return (
    <div role="alert" className="mt-4 flex items-center gap-3 text-a11y-muted">
      <span>{t`Couldn't load this message.`}</span>
      <button type="button" onClick={onRetry} className="font-medium text-a11y-accent">
        {t`Retry`}
      </button>
    </div>
  );
}

export type MessageBackground = "light" | "dark";

/** EmailFrame's height before the document is measured; the placeholder keeps the same box. */
export const FRAME_INITIAL_HEIGHT = 120;

export const frameSurface = (background: MessageBackground) =>
  `overflow-hidden rounded-lg p-4 ${
    background === "dark"
      ? "bg-black ring-1 ring-white/10"
      : "bg-white dark:ring-1 dark:ring-white/10"
  }`;

/** The EmailFrame box at its first height, shown while the body chunk loads. */
export function FramePlaceholder({ background }: { background: MessageBackground }) {
  const { t } = useLingui();
  return (
    <output aria-busy="true" className={`block ${frameSurface(background)}`}>
      <span className="sr-only">{t`Loading…`}</span>
      <span className="block" style={{ height: FRAME_INITIAL_HEIGHT }} />
    </output>
  );
}

export function MessageBodyPlaceholder({ background }: { background: MessageBackground }) {
  return (
    <div className="pt-4">
      <FramePlaceholder background={background} />
    </div>
  );
}

function MessageBodyOrPlaceholder(props: ComponentProps<MessageBodyModule["MessageBody"]>) {
  const body = useMessageBody();
  return body ? (
    <body.MessageBody {...props} />
  ) : (
    <MessageBodyPlaceholder background={props.background} />
  );
}

/** MessageBody from the body chunk, with the placeholder until it loads and Retry if it fails. */
export function LazyMessageBody(props: ComponentProps<MessageBodyModule["MessageBody"]>) {
  return (
    <MessageBodyBoundary>
      <MessageBodyOrPlaceholder {...props} />
    </MessageBodyBoundary>
  );
}

function EmailFrameOrPlaceholder(props: ComponentProps<MessageBodyModule["EmailFrame"]>) {
  const body = useMessageBody();
  return body ? <body.EmailFrame {...props} /> : <FramePlaceholder background={props.background} />;
}

/** EmailFrame from the body chunk, with the placeholder box until it loads and Retry if it fails. */
export function LazyEmailFrame(props: ComponentProps<MessageBodyModule["EmailFrame"]>) {
  return (
    <MessageBodyBoundary>
      <EmailFrameOrPlaceholder {...props} />
    </MessageBodyBoundary>
  );
}
