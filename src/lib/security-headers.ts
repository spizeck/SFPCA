// Baseline HTTP security headers applied to every response via
// next.config.ts headers() -> source "/:path*".
//
// Kept in src/lib (not inline in next.config.ts) so unit tests can assert
// the values without importing the Sentry-wrapped config module.
//
// Deliberately absent: Content-Security-Policy. A correct CSP for this
// site must account for Google Tag Manager, Klaro consent, Firebase, and
// the Google Maps embed — that needs a report-only rollout and is tracked
// separately rather than guessed at here.

export const securityHeaders: { key: string; value: string }[] = [
  {
    // Stop browsers MIME-sniffing responses into something executable.
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    // Clickjacking: nothing legitimately frames this site. SAMEORIGIN
    // (not DENY) keeps same-origin embedding possible if ever needed.
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    // Cap what third-party destinations (social links, wa.me, the Maps
    // embed) learn about the visitor's full URL.
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // The codebase uses no camera/mic/geolocation APIs — deny outright so
    // any future injected script can't quietly opt in.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    // The site is served HTTPS-only on Vercel; make downgrades fail hard.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];
