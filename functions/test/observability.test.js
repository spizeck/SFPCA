// Unit tests for the injected-dependency rebuild + sweep modules.
// Run via `npm test` in functions/ (node:test, no emulator needed).
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {
  triggerVercelRebuild,
  missingRebuildEnv,
  describeRebuildFailure,
} = require("../lib/rebuild");
const {sweepOrphanedReceipts} = require("../lib/sweep");

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

// ---------- sweepOrphanedReceipts ----------

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-01-01T12:00:00Z");

/**
 * Fake storage bucket returning the given file objects.
 * @param {object[]} files Fake file objects.
 * @return {object} Bucket stub.
 */
function fakeBucket(files) {
  return {getFiles: async () => [files]};
}

/**
 * Fake Firestore where doc existence is driven by an ID set.
 * @param {Set<string>} existingIds Document IDs that "exist".
 * @return {object} Firestore stub.
 */
function fakeDb(existingIds) {
  return {
    collection: () => ({
      doc: (id) => ({
        get: async () => ({exists: existingIds.has(id)}),
      }),
    }),
  };
}

/**
 * Fake storage file under receipts/.
 * @param {string} name Object name suffix (registration doc ID shape).
 * @param {number} ageMs Object age relative to NOW.
 * @param {boolean} failDelete Whether delete() should throw.
 * @return {object} File stub.
 */
function fakeFile(name, ageMs = 2 * HOUR, failDelete = false) {
  return {
    name: `receipts/${name}`,
    metadata: {timeCreated: new Date(NOW - ageMs).toISOString()},
    deleted: false,
    delete: async function() {
      if (failDelete) throw Object.assign(new Error("io"), {code: "500"});
      this.deleted = true;
    },
  };
}

test("sweep: deletes orphans, keeps referenced and recent objects",
    async () => {
      const log = fakeLog();
      const orphan = fakeFile("orphan-id");
      const referenced = fakeFile("known-id");
      const recent = fakeFile("inflight-id", 5 * 60 * 1000);
      const nested = {name: "receipts/nested/path"};
      const counts = await sweepOrphanedReceipts({
        bucket: fakeBucket([orphan, referenced, recent, nested]),
        db: fakeDb(new Set(["known-id"])),
        nowMs: NOW,
        log,
        runId: "run-1",
      });
      assert.equal(orphan.deleted, true);
      assert.equal(referenced.deleted, false);
      assert.equal(recent.deleted, false);
      assert.deepEqual(counts, {
        scanned: 3, deleted: 1, skippedRecent: 1,
        skippedMalformed: 1, failed: 0,
      });
      assert.equal(log.calls.info[0].outcome, "ok");
      // Registration IDs / receipt paths must never appear in logs.
      for (const name of ["orphan-id", "known-id", "inflight-id"]) {
        assert.ok(!log.all().includes(name), `log leaked ${name}`);
      }
    });

test("sweep: per-object failure counted, run continues, error logged",
    async () => {
      const log = fakeLog();
      const bad = fakeFile("bad-id", 2 * HOUR, true);
      const good = fakeFile("good-id");
      const counts = await sweepOrphanedReceipts({
        bucket: fakeBucket([bad, good]),
        db: fakeDb(new Set()),
        nowMs: NOW,
        log,
      });
      assert.equal(counts.deleted, 1);
      assert.equal(counts.failed, 1);
      assert.equal(good.deleted, true, "later objects still processed");
      assert.equal(log.calls.error[0].outcome, "partial-failure");
      assert.ok(!log.all().includes("bad-id"));
    });
