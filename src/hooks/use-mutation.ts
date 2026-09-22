"use client";

import { useCallback, useRef, useState } from "react";

// Shared pending-state primitive for admin mutations (#91).
//
// Every meaningful mutation goes through run(): it sets `pending` for
// the duration of the write and — critically — refuses re-entry while a
// call is in flight, so a double-click or impatient re-tap can never
// duplicate the action. Once the call settles, the next invocation runs
// normally; nothing is permanently suppressed.
//
// `pendingKey` distinguishes which action is running when one component
// hosts several (e.g. per-row delete/status buttons): run(fn, key)
// exposes the key so the UI can show a spinner on just that control.
// At most one mutation per component runs at a time — admin tools are
// single-operator workflows, and serializing writes keeps interleaving
// bugs impossible.
export function useMutation<K extends string = string>() {
  const [pending, setPending] = useState(false);
  const [pendingKey, setPendingKey] = useState<K | null>(null);
  // The ref is the authoritative guard: state updates are async, so a
  // second synchronous click would still see stale `pending === false`.
  const busyRef = useRef(false);

  const run = useCallback(
    async <T>(fn: () => Promise<T>, key?: K): Promise<T | undefined> => {
      if (busyRef.current) return undefined;
      busyRef.current = true;
      setPending(true);
      setPendingKey(key ?? null);
      try {
        return await fn();
      } finally {
        busyRef.current = false;
        setPending(false);
        setPendingKey(null);
      }
    },
    [],
  );

  return { pending, pendingKey, run };
}
