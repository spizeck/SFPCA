"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { logError } from "@/lib/logger";

// Shared fallback for App Router error boundaries. Production users
// must never see raw stacks, Firebase internals, or implementation
// details — just a recovery path. `error.digest` is a Next-generated
// opaque hash (not PII) that correlates this screen with the
// server-side log entry; showing it gives maintainers something a
// user can report.
export function ErrorFallback({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
}) {
  useEffect(() => {
    // Client-side render failures only exist in this browser — the
    // digest is the link to the server-rendered log entry Next.js
    // already wrote for server-side failures.
    logError("ui", "render", error, { digest: error.digest });
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground">
          An unexpected error occurred. Please try again — if the problem
          persists, contact us and mention the reference below.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground">
            Reference: <code>{error.digest}</code>
          </p>
        )}
        <div className="flex items-center justify-center gap-3">
          {reset && (
            <Button onClick={reset} variant="default">
              Try again
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/">Go to homepage</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
