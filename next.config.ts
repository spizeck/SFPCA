import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { resolveSentryRuntime } from "./src/lib/sentry";
import { securityHeaders } from "./src/lib/security-headers";

// Single Sentry environment decision for every runtime (#235).
// resolveSentryRuntime() treats only real Vercel infrastructure
// (VERCEL_DEPLOYMENT_ID / VERCEL_REGION) as deployable context — a
// `vercel env pull`-generated .env.local supplies VERCEL_ENV and
// NEXT_PUBLIC_SENTRY_ENVIRONMENT="production" but never those markers,
// so local dev, CI, and E2E can never classify themselves as
// production. The result is injected into the client bundle under
// dedicated names so the browser consumes the resolved decision rather
// than re-reading raw env vars.
const sentryRuntime = resolveSentryRuntime(process.env);

const nextConfig: NextConfig = {
  // Drop the X-Powered-By: Next.js response header — gratuitous
  // framework fingerprinting.
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT: sentryRuntime.environment,
    NEXT_PUBLIC_SENTRY_SEND_EVENTS: sentryRuntime.sendEvents
      ? "true"
      : "false",
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
      },
    ],
  },
  // Keep firebase-admin outside the server bundle: its auth graph pulls
  // jwks-rsa -> jose, and bundling the Node-specific chain into a
  // serverless chunk caused the #144 Vercel runtime outage
  // (ERR_REQUIRE_ESM). Load the real node_modules at runtime instead.
  serverExternalPackages: ["firebase-admin"],
  // Enable video optimization
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // Baseline hardening headers on every response, plus long-cache
  // headers for videos.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: '/videos/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
          {
            key: 'Accept-Ranges',
            value: 'bytes',
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Source-map upload target. These are read from the environment so
  // builds stay credential-free: without SENTRY_AUTH_TOKEN the plugin
  // skips uploading and the build proceeds normally (local/CI).
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Keep build output clean locally; CI still surfaces upload logs.
  silent: !process.env.CI,

  // Upload client + server sourcemaps so production stack traces are
  // symbolicated once #140 configures the auth token.
  widenClientFileUpload: true,
  sourcemaps: {
    // Remove uploaded maps from the public bundle — source maps are a
    // debugging artifact for Sentry, not public assets.
    deleteSourcemapsAfterUpload: true,
  },

  // No SDK-usage telemetry back to Sentry.
  telemetry: false,
});
