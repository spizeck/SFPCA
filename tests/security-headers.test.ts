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
    const policy = map.get("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it("enforces HSTS on the HTTPS-only deployment", () => {
    expect(map.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("does not ship a guessed Content-Security-Policy", () => {
    // A CSP that doesn't account for GTM/Klaro/Firebase/Maps would break
    // the site; it is a separate tracked piece of work.
    expect(map.has("Content-Security-Policy")).toBe(false);
  });
});
