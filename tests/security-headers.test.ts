// Guards the baseline hardening headers in src/lib/security-headers.ts,
// which next.config.ts applies to every response. If a header is dropped
// or weakened (e.g. SAMEORIGIN -> ALLOWALL), this fails.
import { describe, expect, it } from "vitest";
import { securityHeaders } from "@/lib/security-headers";

const map = new Map(securityHeaders.map((h) => [h.key, h.value]));

describe("securityHeaders", () => {
  it("sets MIME-sniffing protection", () => {
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets clickjacking protection", () => {
    expect(map.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("sets a referrer policy", () => {
    expect(map.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("denies unused powerful features", () => {
    // Exact match: substring checks would silently accept a weakened
    // policy like `camera=(), camera=*`.
    expect(map.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("enforces HSTS on the HTTPS-only deployment", () => {
    expect(map.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });

  it("does not ship a guessed Content-Security-Policy", () => {
    // A CSP that doesn't account for GTM/Klaro/Firebase/Maps would break
    // the site; it is a separate tracked piece of work.
    expect(map.has("Content-Security-Policy")).toBe(false);
  });
});
