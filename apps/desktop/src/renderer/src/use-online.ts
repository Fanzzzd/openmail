import { useEffect, useEffectEvent, useState } from "react";

/** Whether the computer has a network connection; `onReconnect` runs each time it comes back. */
export function useOnline(onReconnect: () => void) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const reconnected = useEffectEvent(onReconnect);
  useEffect(() => {
    const update = (event: Event) => {
      setOnline(navigator.onLine);
      if (event.type === "online") reconnected();
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
