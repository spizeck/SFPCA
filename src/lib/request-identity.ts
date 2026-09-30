import "server-only";

// Trusted client identity for public-intake rate limiting (#219).
//
// Trust boundary: on Vercel the platform sets `x-vercel-forwarded-for`
// at the edge and client-supplied copies are not forwarded — it is the
// only header that is platform-controlled under every topology (plain
// `x-forwarded-for`/`x-real-ip` CAN be client-shaped when a fronting
// proxy is in play). We therefore read ONLY that header; where it is
// absent (local dev, E2E, self-hosted `next start`) the caller shares a
// single "unverifiable" bucket rather than trusting spoofable headers.
// A non-Vercel deployment behind its own trusted proxy can opt into a
// header it controls via PUBLIC_INTAKE_IP_HEADER.
//
// Privacy: the stored/logged subject is sha256(salt | ip) — the raw IP
// never reaches Postgres, application logs, or Sentry. RATE_LIMIT_SALT
// should be set in production; when absent the salt derives from the
// already-secret FIREBASE_ADMIN_PRIVATE_KEY so cross-instance keys are
// still stable, and a fixed local-only value covers dev/E2E where no
// secrets exist at all.

import { createHash } from "node:crypto";
import { headers } from "next/headers";

const UNVERIFIABLE_SUBJECT = "unverifiable";
const LOCAL_ONLY_SALT = "sfpca-local-rate-limit-salt";

export function clientIpFromHeaders(
  h: Pick<Headers, "get">,
  env: Record<string, string | undefined> = process.env,
): string | null {
  // A deployment-configured trusted proxy header wins: off-Vercel,
  // nothing strips a client-supplied x-vercel-forwarded-for, so reading
  // it first would let a caller mint arbitrary limiter subjects.
  const trustedHeader = env.PUBLIC_INTAKE_IP_HEADER;
  if (trustedHeader) {
    const value = h.get(trustedHeader)?.split(",")[0]?.trim();
    if (value) return value;
  }
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) {
    // Chain form is client,…,proxies — the leftmost entry is the
    // originating client as observed by the platform.
    const client = vercel.split(",")[0]?.trim();
    if (client) return client;
  }
  return null;
}

function identitySalt(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.RATE_LIMIT_SALT) return env.RATE_LIMIT_SALT;
  if (env.FIREBASE_ADMIN_PRIVATE_KEY) {
    return createHash("sha256")
      .update(env.FIREBASE_ADMIN_PRIVATE_KEY)
      .digest("hex")
      .slice(0, 32);
  }
  return LOCAL_ONLY_SALT;
}

export function subjectForIp(
  ip: string | null,
  env: Record<string, string | undefined> = process.env,
): string {
  const material = ip ?? UNVERIFIABLE_SUBJECT;
  return createHash("sha256")
    .update(`${identitySalt(env)}|${material}`)
    .digest("hex");
}

// Server actions call this to get the current request's limiter subject.
// Never expose the returned value to the client or Sentry context.
export async function publicIntakeSubject(): Promise<string> {
  const h = await headers();
  return subjectForIp(clientIpFromHeaders(h));
}
