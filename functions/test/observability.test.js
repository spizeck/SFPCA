// Unit tests for the injected-dependency rebuild module.
// The receipt sweeper moved to the app runtime (Vercel cron +
// src/lib/registry/receipt-sweep.ts, #183) — its tests live there.
// Run via `npm test` in functions/ (node:test, no emulator needed).
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {
  triggerVercelRebuild,
  missingRebuildEnv,
  describeRebuildFailure,
} = require("../lib/rebuild");

/**
 * Captures structured log calls so tests can assert on fields and,
 * critically, scan everything emitted for secrets/identifiers.
 * @return {object} Logger with per-level call arrays.
 */
function fakeLog() {
  const calls = {info: [], warn: [], error: []};
  return {
    calls,
    info: (e) => calls.info.push(e),
    warn: (e) => calls.warn.push(e),
    error: (e) => calls.error.push(e),
    all: () => JSON.stringify(calls),
  };
}

const SECRET_TOKEN = "SECRET-DEPLOY-HOOK-TOKEN";
const ENV = {VERCEL_TOKEN: SECRET_TOKEN, VERCEL_PROJECT_ID: "prj_123"};

// ---------- triggerVercelRebuild ----------

test("rebuild: missing configuration warns and skips without throwing",
    async () => {
      const log = fakeLog();
      const result = await triggerVercelRebuild({env: {}, log});
      assert.equal(result, false);
      assert.equal(log.calls.warn.length, 1);
      assert.match(log.calls.warn[0].reason, /VERCEL_TOKEN/);
      assert.equal(log.calls.error.length, 0);
    });

test("rebuild: success logs status only, never the hook URL", async () => {
  const log = fakeLog();
  let seenUrl;
  const result = await triggerVercelRebuild({
    env: ENV,
    post: async (url) => {
      seenUrl = url;
      return {status: 201};
    },
    log,
    eventId: "evt-1",
  });
  assert.equal(result, true);
  assert.ok(seenUrl.includes(SECRET_TOKEN), "post must get the real URL");
  assert.equal(log.calls.info[0].httpStatus, 201);
  assert.equal(log.calls.info[0].eventId, "evt-1");
  assert.ok(!log.all().includes(SECRET_TOKEN),
      "no log entry may contain the deploy-hook token");
});

test("rebuild: non-2xx response throws and logs httpStatus", async () => {
  const log = fakeLog();
  const axiosError = new Error("Request failed with status code 500");
  axiosError.response = {status: 500, data: {error: {code: "internal"}}};
  axiosError.config = {url: `https://x/${SECRET_TOKEN}`};
  await assert.rejects(
      () => triggerVercelRebuild({
        env: ENV, post: async () => Promise.reject(axiosError), log,
      }),
      (err) => {
        assert.match(err.message, /HTTP 500/);
        assert.ok(!err.message.includes(SECRET_TOKEN));
        return true;
      },
  );
  assert.equal(log.calls.error[0].httpStatus, 500);
  assert.equal(log.calls.error[0].upstreamCode, "internal");
  assert.ok(!log.all().includes(SECRET_TOKEN));
});

test("rebuild: timeout/network failure throws without httpStatus", async () => {
  const log = fakeLog();
  const timeout = new Error("timeout of 10000ms exceeded");
  timeout.code = "ECONNABORTED";
  timeout.config = {url: `https://x/${SECRET_TOKEN}`};
  await assert.rejects(
      () => triggerVercelRebuild({
        env: ENV, post: async () => Promise.reject(timeout), log,
      }),
      /ECONNABORTED/,
  );
  assert.equal(log.calls.error[0].httpStatus, null);
  assert.equal(log.calls.error[0].errorCode, "ECONNABORTED");
  assert.ok(!log.all().includes(SECRET_TOKEN));
});

test("rebuild: missingRebuildEnv names only absent vars", () => {
  assert.deepEqual(missingRebuildEnv({}),
      ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"]);
  assert.deepEqual(missingRebuildEnv({VERCEL_TOKEN: "x"}),
      ["VERCEL_PROJECT_ID"]);
  assert.deepEqual(missingRebuildEnv(ENV), []);
});

test("rebuild: describeRebuildFailure keeps only safe fields", () => {
  const err = new Error("boom");
  err.code = "ENOTFOUND";
  err.response = {status: 502, data: "<html>proxy error</html>"};
  const fields = describeRebuildFailure(err);
  assert.equal(fields.httpStatus, 502);
  assert.equal(fields.errorCode, "ENOTFOUND");
  assert.equal(fields.upstreamCode, undefined);
});
