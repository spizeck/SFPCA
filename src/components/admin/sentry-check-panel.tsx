"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { fireSentryVerification } from "@/app/admin/sentry-check/actions";
import {
  SENTRY_VERIFICATION_MARKER,
  sentryVerificationError,
} from "@/lib/sentry-verification";

// Controlled Sentry verification panel (RUNBOOK §15). Both buttons
// produce exactly one synthetic event through the real capture paths:
//
// - Browser: throws during render → app/error.tsx boundary →
//   ErrorFallback's captureException (the #139 capture site) → the
//   operator also sees the real user-facing fallback and can compare
//   its Reference digest against Vercel logs.
// - Server: calls the admin-gated server action → throw propagates →
//   instrumentation.ts onRequestError → Sentry.
//
// No direct Sentry calls here — the point is to exercise the real
// pipeline including the privacy boundary, not to bypass it.
export function SentryCheckPanel() {
  const [armBrowserError, setArmBrowserError] = useState(false);
  const [serverNote, setServerNote] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);

  if (armBrowserError) {
    throw sentryVerificationError("browser");
  }

  const fireServerError = async () => {
    setFiring(true);
    setServerNote(null);
    try {
      const result = await fireSentryVerification();
      setServerNote(
        result.fired
          ? "Event sent — check Sentry."
          : "Not authorized — no event was sent.",
      );
    } catch {
      setServerNote(
        "Server test error thrown — check Sentry Issues and Vercel runtime logs.",
      );
    } finally {
      setFiring(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Sentry Verification</h1>
        <p className="text-muted-foreground mt-2">
          Controlled synthetic errors for verifying production Sentry
          configuration (RUNBOOK §15). Each event is tagged{" "}
          <code>{SENTRY_VERIFICATION_MARKER}</code> and contains no real
          data.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Browser capture path</CardTitle>
          <CardDescription>
            Throws a synthetic error through the real error boundary —
            the page will be replaced by the same &ldquo;Something went
            wrong&rdquo; fallback a visitor would see, including its
            Reference digest. Exactly one Sentry event is produced.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => setArmBrowserError(true)}
          >
            Throw browser test error
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server capture path</CardTitle>
          <CardDescription>
            Calls an admin-gated server action that throws — captured by
            the server-side request-error hook. The button reports
            &ldquo;Not authorized&rdquo; without sending anything if the
            session check fails.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="destructive"
            onClick={fireServerError}
            disabled={firing}
          >
            {firing ? "Firing…" : "Throw server test error"}
          </Button>
          {serverNote && (
            <p className="text-sm text-muted-foreground">{serverNote}</p>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        If Sentry is not configured on this environment, the errors
        still occur but nothing is sent — verify on the environment
        where the DSN is set.
      </p>
    </div>
  );
}
