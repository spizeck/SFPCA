"use client";

import { ErrorFallback } from "@/components/error-fallback";

// Last-resort boundary for failures inside the root layout itself —
// it must render its own <html>/<body> because the layout it replaces
// may be what failed.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <ErrorFallback error={error} reset={reset} />
      </body>
    </html>
  );
}
