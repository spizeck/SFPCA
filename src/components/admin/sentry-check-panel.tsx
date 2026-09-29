"use client";

import { Component, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  fireSentryCaughtVerification,
  fireSentryVerification,
} from "@/app/admin/sentry-check/actions";
import { ErrorFallback } from "@/components/error-fallback";
import {
  SENTRY_VERIFICATION_MARKER,
  sentryVerificationError,
} from "@/lib/sentry-verification";

// Controlled Sentry verification panel (RUNBOOK §15). All three
// triggers produce exactly one synthetic event through the real
// capture paths:
//
// - Browser: throws during render → caught by the dedicated
//   VerificationBoundary below → the SAME shared ErrorFallback runs
//   (logError + captureException, the #139 capture site). The boundary
//   just contains the crash inside this card instead of letting it
//   replace the whole page through app/error.tsx — the capture path
//   being verified is identical.
// - Server: calls the admin-gated server action → throw propagates →
//   instrumentation.ts onRequestError → Sentry (the action POST
//   intentionally returns HTTP 500; the SDK flush is bound to the
//   request lifecycle via after() with a timeout derived from the
//   Vercel invocation deadline, and a failed flush is logged so a
//   dropped event is observable).
// - Caught: calls the admin-gated server action → catches the throw →
//   logError() → console + Sentry (the #218 path every operational
//   catch block uses). The action still returns a normal result.
//
// No direct Sentry calls here — the point is to exercise the real
// pipeline including the privacy boundary, not to bypass it.

// Renders nothing — exists only so the render-throw can be wrapped in
// the contained boundary instead of living in this component's own
// render (a boundary cannot catch errors thrown by the component that
// renders it).
function SyntheticBrowserThrow(): null {
  throw sentryVerificationError("browser");
}

// Containment for the synthetic browser crash: a real React error
// boundary that renders the real shared ErrorFallback (compact — same
// capture code path as app/error.tsx, minus the full-viewport chrome).
// "Try again" resets the boundary and disarms the throw.
class VerificationBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: (Error & { digest?: string }) | null }
> {
  state = { error: null as (Error & { digest?: string }) | null };

  static getDerivedStateFromError(error: Error & { digest?: string }) {
    return { error };
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset();
  };

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback error={this.state.error} reset={this.reset} compact />
      );
    }
    return this.props.children;
  }
}

export function SentryCheckPanel() {
  const [armBrowserError, setArmBrowserError] = useState(false);
  const [serverNote, setServerNote] = useState<string | null>(null);
  const [caughtNote, setCaughtNote] = useState<string | null>(null);
  const [firing, setFiring] = useState(false);
  const [firingCaught, setFiringCaught] = useState(false);

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

  const fireCaughtError = async () => {
    setFiringCaught(true);
    setCaughtNote(null);
    try {
      const result = await fireSentryCaughtVerification();
      setCaughtNote(
        result.fired
          ? "Caught error logged — check Sentry and Vercel runtime logs."
          : "Not authorized — no event was sent.",
      );
    } catch {
      setCaughtNote("Action call failed — nothing was logged.");
    } finally {
      setFiringCaught(false);
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
            Throws a synthetic error during render so it lands in a real
            error boundary — the same <code>ErrorFallback</code> capture
            path visitors hit on an unexpected render failure. Exactly
            one Sentry event is produced.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            This intentionally triggers the &ldquo;Something went
            wrong&rdquo; error screen — contained to this card, not the
            whole page. That is expected: it proves the real
            boundary-capture path end to end.
          </p>
          <VerificationBoundary onReset={() => setArmBrowserError(false)}>
            {armBrowserError ? (
              <SyntheticBrowserThrow />
            ) : (
              <Button
                variant="destructive"
                onClick={() => setArmBrowserError(true)}
              >
                Throw browser test error
              </Button>
            )}
          </VerificationBoundary>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server capture path</CardTitle>
          <CardDescription>
            Calls an admin-gated server action that throws — the action
            call intentionally fails (HTTP 500) and the error is
            captured by the server-side request-error hook
            (instrumentation <code>onRequestError</code>) exactly once.
            The button reports &ldquo;Not authorized&rdquo; without
            sending anything if the session check fails.
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

      <Card>
        <CardHeader>
          <CardTitle>Caught operational path</CardTitle>
          <CardDescription>
            Calls an admin-gated server action that throws, catches the
            error, and logs it through <code>logError</code> — the same
            shape as cron, webhook, and action failure handlers. The
            action returns a normal result while the error reports to
            Sentry: exactly one event, tagged{" "}
            <code>admin / sentry-check-caught</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="destructive"
            onClick={fireCaughtError}
            disabled={firingCaught}
          >
            {firingCaught ? "Firing…" : "Fire caught test error"}
          </Button>
          {caughtNote && (
            <p className="text-sm text-muted-foreground">{caughtNote}</p>
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
