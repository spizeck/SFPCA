// Vercel rebuild trigger, split from index.js so the failure matrix is
// unit-testable with an injected transport.
//
// Privacy/secret rules for this module:
// - The deploy-hook URL embeds VERCEL_TOKEN — it is NEVER logged and
//   never re-thrown attached to an error (axios errors carry
//   error.config.url).
// - Vercel response bodies are not logged either: they contain
//   deployment metadata we don't need. Status code + axios error code
//   are sufficient to diagnose the failure mode.
const axios = require("axios");

// A hung outbound request must not pin a function execution open
// indefinitely — fail the attempt so it is visible as a failure.
const REBUILD_TIMEOUT_MS = 10 * 1000;

const REQUIRED_REBUILD_ENV = ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"];

/**
 * Returns the names (never values) of missing rebuild configuration.
 * @param {object} env Environment map.
 * @return {string[]} Missing variable names.
 */
function missingRebuildEnv(env) {
  return REQUIRED_REBUILD_ENV.filter((name) => !env[name]);
}

/**
 * Normalize an axios failure into safe log fields.
 * @param {object} error The caught error.
 * @return {object} Safe fields: httpStatus, errorCode, upstreamCode.
 */
function describeRebuildFailure(error) {
  const fields = {
    httpStatus: error.response?.status ?? null,
    errorCode: typeof error.code === "string" ? error.code : null,
  };
  // Vercel error payloads look like {error: {code, message}}; the code
  // is a short stable string worth keeping. Anything else is dropped.
  const upstreamCode = error.response?.data?.error?.code;
  if (typeof upstreamCode === "string") {
    fields.upstreamCode = upstreamCode;
  }
  return fields;
}

/**
 * Requests a Vercel rebuild via the deploy hook.
 * @param {object} deps Injected dependencies for testability.
 * @param {object} deps.env Environment map (defaults to process.env).
 * @param {Function} deps.post Transport; defaults to a timed axios POST.
 * @param {object} deps.log Structured logger (firebase-functions/logger
 *   or console).
 * @param {string} deps.eventId Correlation id for the triggering event.
 * @return {Promise<boolean>} true when the hook accepted the request,
 *   false when rebuilds are not configured.
 * @throws {Error} On HTTP error, timeout, or network failure — the
 *   caller must treat a thrown error as a failed rebuild.
 */
async function triggerVercelRebuild({
  env = process.env,
  post = (url) =>
    axios.post(url, {}, {
      headers: {"Content-Type": "application/json"},
      timeout: REBUILD_TIMEOUT_MS,
    }),
  log = console,
  eventId,
} = {}) {
  const base = {subsystem: "rebuild", operation: "vercel-hook", eventId};

  const missing = missingRebuildEnv(env);
  if (missing.length > 0) {
    // Configuration absence is deliberate in some environments but
    // fatal to the rebuild pipeline in production — warn so it is
    // diagnosable without failing the function.
    log.warn({...base, outcome: "skipped",
      reason: `missing env: ${missing.join(",")}`});
    return false;
  }

  try {
    const response = await post(
        `https://api.vercel.com/v1/integrations/deploy/` +
        `prj_${env.VERCEL_PROJECT_ID}/${env.VERCEL_TOKEN}`,
    );
    log.info({...base, outcome: "ok", httpStatus: response.status});
    return true;
  } catch (error) {
    const fields = describeRebuildFailure(error);
    log.error({...base, outcome: "failed", ...fields});
    // Rethrow a sanitized error: the original axios error carries
    // config.url containing the deploy-hook token.
    const status = fields.httpStatus;
    throw new Error(
        "Vercel rebuild request failed" +
        (status ? ` (HTTP ${status})` : ` (${fields.errorCode ?? "network"})`),
    );
  }
}

module.exports = {
  triggerVercelRebuild,
  missingRebuildEnv,
  describeRebuildFailure,
  REBUILD_TIMEOUT_MS,
};
