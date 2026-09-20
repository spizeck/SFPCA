"use client";

import { ErrorFallback } from "@/components/error-fallback";

// Segment boundary for every page below the root layout (public,
// login, admin). Kept generic on purpose — one honest fallback with a
// retry beats N nearly-identical per-route copies.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorFallback error={error} reset={reset} />;
}
