import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
      },
    ],
  },
  // Enable video optimization
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // Configure headers for video optimization
  async headers() {
    return [
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
