"use client";

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { logError } from "@/lib/logger";
import { cn } from "@/lib/utils";

// Shared fallback for App Router error boundaries. Production users
// must never see raw stacks, Firebase internals, or implementation
// details — just a recovery path. `error.digest` is a Next-generated
// opaque hash (not PII) that correlates this screen with the
// server-side log entry; showing it gives maintainers something a
// user can report.
//
// `compact` drops the full-viewport sizing so the same fallback — and
// therefore the same logging + Sentry capture path — can render inside
// a contained boundary (the /admin/sentry-check verification surface).
export function ErrorFallback({
  error,
  reset,
  compact = false,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  compact?: boolean;
}) {
  useEffect(() => {
    // Client-side render failures only exist in this browser — the
    // digest is the link to the server-rendered log entry Next.js
    // already wrote for server-side failures. sentry:false — the
    // captureException below is this error's one report.
    logError("ui", "render", error, { digest: error.digest }, { sentry: false });
    // Errors reaching App Router boundaries never reach Sentry's global
    // handlers (the boundary swallows them), so they are captured here —
    // the single shared site for error.tsx and global-error.tsx, which
    // keeps each failure to exactly one event. The digest tag correlates
    // the Sentry issue with the Vercel runtime log entry. No-ops when
    // Sentry is not initialized; beforeSend applies the PII boundary.
    Sentry.captureException(error, {
      tags: error.digest ? { "nextjs.error_digest": error.digest } : {},
    });
  }, [error]);

  return (
    <div
      className={cn(
        "flex items-center justify-center bg-background px-4",
        compact ? "py-10" : "min-h-screen",
      )}
    >
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
