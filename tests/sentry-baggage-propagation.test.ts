// Regression guard for #264 / GHSA-8988-4f7v-96qf ("OpenTelemetry Core:
// unbounded memory allocation in W3C Baggage propagation").
//
// firebase-tools -> @google-cloud/pubsub legitimately requires
// @opentelemetry/core@^1.x, so npm keeps a 1.30.1 copy isolated under
// the dev-only firebase-tools subtree. The Sentry packages declare the
// peer range ^1.30.1 || ^2.1.0 and were deduping to that vulnerable
// copy — the production-runtime path. Scoped overrides in package.json
// pin @sentry/opentelemetry and @sentry/node-core onto core >=2.8.0
// (the advisory's first fixed release). These tests prove:
//
//   1. Every Sentry package resolves @opentelemetry/core to a fixed
//      2.x copy, and the copy itself enforces the W3C bounds
//      (180 members / 4096 bytes per member / 8192 bytes total).
//   2. The remaining 1.30.1 copy is reachable only from the dev-only
//      @google-cloud/pubsub subtree — no production package resolves it.
//   3. SentryPropagator.extract — the class registered as the global
//      propagator by @sentry/node's initOtel and the real request
//      boundary for incoming sentry-trace/baggage headers — continues
//      to parse valid headers and fails safely on malformed or
//      oversized input.
//
// Pure module/parsing assertions: no SDK init, no network, and every
// input is deliberately bounded — nothing here approximates a real
// memory-exhaustion payload.
//
// Runs in Node: context propagation is a server-side path, and
// createRequire needs real Node module resolution, not jsdom.
// @vitest-environment node
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ROOT_CONTEXT,
  defaultTextMapGetter,
  propagation,
  trace,
} from "@opentelemetry/api";
import { W3CBaggagePropagator } from "@opentelemetry/core";
import { SentryPropagator } from "@sentry/opentelemetry";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// GHSA-8988-4f7v-96qf: vulnerable <2.8.0, first fixed release 2.8.0.
const FIXED_MAJOR = 2;
const FIXED_MINOR = 8;

// Resolve a specifier exactly the way a package inside node_modules
// would at runtime: Node walks up from the dependent's own directory,
// so a createRequire anchored there sees the same copy the production
// import gets.
function requireAs(pkg: string): NodeJS.Require {
  return createRequire(path.join(REPO_ROOT, "node_modules", pkg, "index.js"));
}

function resolvedCoreVersion(asPkg: string): string {
  const req = requireAs(asPkg);
  const pkgJson = req("@opentelemetry/core/package.json") as {
    version: string;
  };
  return pkgJson.version;
}

function resolvedCorePath(asPkg: string): string {
  return requireAs(asPkg).resolve("@opentelemetry/core/package.json");
}

function expectFixedCore(version: string) {
  const [major, minor] = version.split(".").map(Number);
  expect(major).toBe(FIXED_MAJOR);
  expect(minor).toBeGreaterThanOrEqual(FIXED_MINOR);
}

const VALID_TRACE_ID = "a".repeat(32);
const VALID_SPAN_ID = "b".repeat(16);
const VALID_SENTRY_TRACE = `${VALID_TRACE_ID}-${VALID_SPAN_ID}-1`;

describe("resolved @opentelemetry/core on the Sentry production path", () => {
  test.each([
    "@sentry/nextjs",
    "@sentry/node",
    "@sentry/node-core",
    "@sentry/opentelemetry",
  ])("%s resolves a fixed @opentelemetry/core >=2.8.0", (pkg) => {
    expectFixedCore(resolvedCoreVersion(pkg));
  });

  test("the only remaining 1.x copy is isolated under dev-only @google-cloud/pubsub", () => {
    const version = resolvedCoreVersion("@google-cloud/pubsub");
    const resolvedPath = resolvedCorePath("@google-cloud/pubsub");
    // pubsub pins ^1.30.1 — it cannot take 2.x, so its copy must be
    // nested inside its own subtree (reachable only to firebase-tools,
    // a devDependency) rather than the hoisted root copy production
    // resolves.
    expect(version.startsWith("1.")).toBe(true);
    expect(resolvedPath).toContain(
      path.join("@google-cloud", "pubsub", "node_modules"),
    );
  });
});

describe("W3CBaggagePropagator bounds (the fixed 2.x parser)", () => {
  const propagator = new W3CBaggagePropagator();

  const extractEntries = (baggage: string | string[]) =>
    propagation
      .getBaggage(
        propagator.extract(ROOT_CONTEXT, { baggage }, defaultTextMapGetter),
      )
      ?.getAllEntries() ?? [];

  test("parses a valid baggage header", () => {
    expect(extractEntries("a=1,b=2")).toEqual([
      ["a", { value: "1" }],
      ["b", { value: "2" }],
    ]);
  });

  test("malformed members are skipped without throwing", () => {
    expect(extractEntries("noequals,=novalue,ok=1")).toEqual([
      ["ok", { value: "1" }],
    ]);
  });

  test("member count is bounded at the W3C limit (180)", () => {
    const many = Array.from({ length: 200 }, (_, i) => `k${i}=v`).join(",");
    // Vulnerable 1.x parsed every member; the fixed parser must cap.
    expect(extractEntries(many).length).toBeLessThanOrEqual(180);
  });

  test("a single oversized member is dropped", () => {
    const oversized = `k=${"x".repeat(5000)}`; // > 4096-byte member limit
    expect(extractEntries(`${oversized},z=9`)).toEqual([
      ["z", { value: "9" }],
    ]);
  });

  test("total parsed size is bounded at the W3C limit (8192)", () => {
    // 50 members * ~204 bytes each ≈ 10KB — must be truncated.
    const wide = Array.from(
      { length: 50 },
      (_, i) => `k${i}=${"v".repeat(200)}`,
    ).join(",");
    const entries = extractEntries(wide);
    expect(entries.length).toBeLessThan(50);
  });

  test("the cap applies cumulatively across multiple header values", () => {
    // Two header values of 150 members each — the fixed parser tracks
    // the running count/size across values, so the total stays <=180.
    const first = Array.from({ length: 150 }, (_, i) => `a${i}=v`).join(",");
    const second = Array.from({ length: 150 }, (_, i) => `b${i}=v`).join(",");
    expect(extractEntries([first, second]).length).toBeLessThanOrEqual(180);
  });
});

describe("SentryPropagator.extract — the real request boundary", () => {
  const propagator = new SentryPropagator();

  const extract = (carrier: Record<string, string | string[]>) =>
    trace.getSpanContext(
      propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter),
    );

  test("a request with no tracing headers produces no remote span context", () => {
    expect(extract({})).toBeUndefined();
  });

  test("valid sentry-trace + baggage continue the remote trace", () => {
    const spanContext = extract({
      "sentry-trace": VALID_SENTRY_TRACE,
      baggage: "sentry-release=1.0.0,sentry-environment=production",
    });
    expect(spanContext).toMatchObject({
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID,
      isRemote: true,
      traceFlags: 1,
    });
  });

  test("malformed baggage does not break trace continuation", () => {
    const spanContext = extract({
      "sentry-trace": VALID_SENTRY_TRACE,
      baggage: "@@@,,=,noequals",
    });
    expect(spanContext).toMatchObject({
      traceId: VALID_TRACE_ID,
      isRemote: true,
    });
  });

  test("malformed sentry-trace fails closed without throwing", () => {
    expect(
      extract({ "sentry-trace": "not-a-trace-header", baggage: "a=1" }),
    ).toBeUndefined();
  });

  test("an unusually large but bounded baggage header is handled", () => {
    // 64KB is far beyond real HTTP header limits (Node caps total
    // headers at ~16KB); this proves extract stays a bounded operation,
    // not that an attacker can deliver it.
    const spanContext = extract({
      "sentry-trace": VALID_SENTRY_TRACE,
      baggage: `k=${"y".repeat(64 * 1024)}`,
    });
    expect(spanContext).toMatchObject({ isRemote: true });
  });

  test("baggage with many members is processed without throwing", () => {
    const many = Array.from({ length: 200 }, (_, i) => `k${i}=v`).join(",");
    const spanContext = extract({
      "sentry-trace": VALID_SENTRY_TRACE,
      baggage: many,
    });
    expect(spanContext).toMatchObject({ isRemote: true });
  });
});
