// Regression guard for #146 — production client bundles only receive
// NEXT_PUBLIC_* values when they are referenced as statically analyzable
// `process.env.NEXT_PUBLIC_*` member expressions. The original defect
// read the DSN through `getSentryDsn()`, whose `env = process.env`
// default parameter compiles to a runtime property lookup on the
// browser's empty process shim — the value is never inlined, the DSN is
// undefined, and Sentry.init is skipped silently.
//
// A unit test that calls getSentryDsn({ NEXT_PUBLIC_SENTRY_DSN: ... })
// cannot catch that — it exercises a real process.env, not build-time
// substitution. This test instead compiles src/instrumentation-client.ts
// with esbuild's `define` (the same member-expression substitution
// Next.js/Turbopack performs on client bundles), evaluates the emitted
// bundle in a context where `process.env` is the empty shim a browser
// sees, and asserts the build-time DSN actually reaches Sentry.init.
//
// The SDK is stubbed at the bundler level and the DSN is fake — nothing
// here can contact sentry.io.
//
// Runs in the Node environment: this is a bundling check, not DOM, and
// esbuild's import-time invariants are not satisfied under jsdom.
// @vitest-environment node
import { build, type Plugin } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, test } from "vitest";

const FAKE_DSN =
  "https://deadbeefcafe0123456789abcdef01@o424242.ingest.sentry.io/42424242";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

// @sentry/nextjs is replaced with a recording stub; "@/..." resolves
// against src/ exactly as tsconfig paths do in the real build.
const moduleResolution: Plugin = {
  name: "module-resolution",
  setup(b) {
    b.onResolve({ filter: /^@sentry\/nextjs$/ }, () => ({
      path: "@sentry/nextjs",
      namespace: "sentry-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "sentry-stub" }, () => ({
      contents: `
        globalThis.__sentryInitCalls = [];
        export const init = (options) => {
          globalThis.__sentryInitCalls.push(options);
        };
        export const captureRouterTransitionStart = () => {};
        export const breadcrumbsIntegration = (options) => ({
          name: "Breadcrumbs",
          options,
        });
      `,
      loader: "js",
    }));
    b.onResolve({ filter: /^@\// }, (args) => {
      const base = path.resolve(SRC_DIR, args.path.slice(2));
      // Plugin-returned paths bypass extension resolution.
      for (const ext of ["", ".ts", ".tsx", ".js", "/index.ts"]) {
        const candidate = base + ext;
        if (fs.existsSync(candidate)) return { path: candidate };
      }
      return { path: base };
    });
  },
};

// Bundles instrumentation-client.ts under the same substitution rules
// the production client build applies: direct `process.env.<KEY>`
// member expressions are replaced with build-time values. Anything the
// bundler did NOT inline stays a runtime lookup, which the evaluation
// sandbox resolves against the empty process shim a browser sees.
async function bundleClientInit(env: Record<string, string | undefined>) {
  const define: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      define[`process.env.${key}`] = JSON.stringify(value);
    }
  }
  const result = await build({
    entryPoints: [path.join(SRC_DIR, "instrumentation-client.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
    define,
    plugins: [moduleResolution],
  });
  return result.outputFiles[0].text;
}

function evaluateBundle(code: string): Record<string, unknown>[] {
  const sandbox: { __sentryInitCalls?: unknown[] } & {
    [key: string]: unknown;
  } = {
    // The browser's process.env holds only what the build inlined —
    // dynamic lookups like env.NEXT_PUBLIC_SENTRY_DSN see nothing.
    process: { env: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return (sandbox.__sentryInitCalls ?? []) as Record<string, unknown>[];
}

describe("client bundle env substitution (#146)", () => {
  test("Sentry.init receives the build-time DSN when the resolved decision enables sending", async () => {
    // Mirrors what next.config.ts injects on a Vercel production build:
    // the DSN plus the resolved send/environment pair (#235).
    const code = await bundleClientInit({
      NEXT_PUBLIC_SENTRY_DSN: FAKE_DSN,
      NEXT_PUBLIC_SENTRY_SEND_EVENTS: "true",
      NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT: "production",
      NODE_ENV: "production",
    });
    // The DSN must be inlined into the emitted client code — a runtime
    // lookup on the browser's process shim can never see it.
    expect(code).toContain(FAKE_DSN);
    const initCalls = evaluateBundle(code);
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].dsn).toBe(FAKE_DSN);
    expect(initCalls[0].environment).toBe("production");
    // Privacy boundary survives bundling.
    expect(initCalls[0].sendDefaultPii).toBe(false);
    expect(initCalls[0].tracesSampleRate).toBe(0);
    expect(initCalls[0].enableLogs).toBe(false);
  });

  test("the resolved environment label reaches the bundle", async () => {
    const code = await bundleClientInit({
      NEXT_PUBLIC_SENTRY_DSN: FAKE_DSN,
      NEXT_PUBLIC_SENTRY_SEND_EVENTS: "true",
      NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT: "preview",
      NODE_ENV: "production",
    });
    const initCalls = evaluateBundle(code);
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].environment).toBe("preview");
  });

  test("Sentry.init is skipped when the build resolved sending off — even with a DSN inlined", async () => {
    // The local/E2E case (#235): a pulled .env.local supplies the real
    // DSN, but next.config injected send=false + a non-production label.
    const code = await bundleClientInit({
      NEXT_PUBLIC_SENTRY_DSN: FAKE_DSN,
      NEXT_PUBLIC_SENTRY_SEND_EVENTS: "false",
      NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT: "test",
      NODE_ENV: "development",
    });
    expect(evaluateBundle(code)).toHaveLength(0);
  });

  test("Sentry.init is skipped when the resolved variables were never injected", async () => {
    // Defensive: a bundle built without the resolved pair (e.g. a stale
    // config) must not send just because a DSN exists.
    const code = await bundleClientInit({
      NEXT_PUBLIC_SENTRY_DSN: FAKE_DSN,
      NODE_ENV: "production",
    });
    expect(evaluateBundle(code)).toHaveLength(0);
  });

  test("Sentry.init is skipped when the build supplies no DSN", async () => {
    const code = await bundleClientInit({
      NEXT_PUBLIC_SENTRY_SEND_EVENTS: "true",
      NEXT_PUBLIC_SENTRY_RESOLVED_ENVIRONMENT: "production",
      NODE_ENV: "production",
    });
    expect(evaluateBundle(code)).toHaveLength(0);
  });
});
