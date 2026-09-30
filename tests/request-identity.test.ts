// Trusted client-identity tests (#219). The whole point: nothing a
// client sends can mint an arbitrary limiter identity — only the
// platform-controlled header counts, and the stored subject is a salted
// digest that never contains the raw address.

import { describe, expect, test } from "vitest";
import {
  clientIpFromHeaders,
  subjectForIp,
} from "@/lib/request-identity";

function h(entries: Record<string, string>): Pick<Headers, "get"> {
  const map = new Map(Object.entries(entries));
  return { get: (k: string) => map.get(k.toLowerCase()) ?? null };
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("clientIpFromHeaders", () => {
  test("prefers the platform-controlled Vercel header", () => {
    const headers = h({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-forwarded-for": "9.9.9.9", // client-supplied — ignored
      "x-real-ip": "8.8.8.8", // client-supplied — ignored
    });
    expect(clientIpFromHeaders(headers, {})).toBe("203.0.113.7");
  });

  test("uses the leftmost entry of a Vercel chain", () => {
    const headers = h({
      "x-vercel-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2",
    });
    expect(clientIpFromHeaders(headers, {})).toBe("203.0.113.7");
  });

  test("spoofed forwarding headers mint no identity off Vercel", () => {
    const headers = h({
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "5.6.7.8",
    });
    // Neither header is trusted without the platform marker or an
    // operator-declared trusted header — the client cannot pick a key.
    expect(clientIpFromHeaders(headers, {})).toBeNull();
  });

  test("operator-declared trusted header works on non-Vercel deployments", () => {
    const headers = h({ "x-corp-client-ip": "192.0.2.55" });
    expect(
      clientIpFromHeaders(headers, {
        PUBLIC_INTAKE_IP_HEADER: "x-corp-client-ip",
      }),
    ).toBe("192.0.2.55");
    // ...but it is never consulted while the platform header exists.
    const both = h({
      "x-vercel-forwarded-for": "203.0.113.7",
      "x-corp-client-ip": "192.0.2.55",
    });
    expect(
      clientIpFromHeaders(both, {
        PUBLIC_INTAKE_IP_HEADER: "x-corp-client-ip",
      }),
    ).toBe("203.0.113.7");
  });
});

describe("subjectForIp", () => {
  test("produces a salted sha256 digest, never the raw IP", () => {
    const subject = subjectForIp("203.0.113.7", {
      RATE_LIMIT_SALT: "test-salt",
    });
    expect(subject).toMatch(HEX64);
    expect(subject).not.toContain("203.0.113.7");
  });

  test("is deterministic for the same ip+salt and changes with salt", () => {
    const env = { RATE_LIMIT_SALT: "test-salt" };
    expect(subjectForIp("203.0.113.7", env)).toBe(
      subjectForIp("203.0.113.7", env),
    );
    expect(subjectForIp("203.0.113.7", env)).not.toBe(
      subjectForIp("203.0.113.7", { RATE_LIMIT_SALT: "other-salt" }),
    );
    expect(subjectForIp("203.0.113.7", env)).not.toBe(
      subjectForIp("203.0.113.8", env),
    );
  });

  test("missing IP collapses to one shared unverifiable identity", () => {
    const a = subjectForIp(null, { RATE_LIMIT_SALT: "s" });
    const b = subjectForIp(null, { RATE_LIMIT_SALT: "s" });
    expect(a).toBe(b);
    expect(a).toMatch(HEX64);
  });
});
