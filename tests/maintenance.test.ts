// Unit tests for the maintenance-mode routing predicates.
// Run via `npm test` / `npm run test:maintenance` (no emulator or
// credentials needed).
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  isMaintenanceMode,
  isMaintenanceExemptPath,
  getProxyAction,
} from "../src/lib/maintenance";

const ON = { SITE_MAINTENANCE_MODE: "true" };
const OFF = {};

// --- Flag semantics -------------------------------------------------------

test("maintenance mode is on only when the variable is exactly 'true'", () => {
  assert.equal(isMaintenanceMode(ON), true);
  assert.equal(isMaintenanceMode(OFF), false);
  assert.equal(isMaintenanceMode({ SITE_MAINTENANCE_MODE: "false" }), false);
  assert.equal(isMaintenanceMode({ SITE_MAINTENANCE_MODE: "1" }), false);
});

// --- Maintenance mode disabled --------------------------------------------

test("public routes pass through normally when disabled", () => {
  assert.equal(getProxyAction("/", false, OFF), "allow");
  assert.equal(getProxyAction("/animal-adoptions", false, OFF), "allow");
  assert.equal(getProxyAction("/contact", false, OFF), "allow");
});

// --- Maintenance mode enabled ---------------------------------------------

test("homepage is gated when enabled", () => {
  assert.equal(getProxyAction("/", false, ON), "maintenance");
});

test("nested public routes are gated when enabled", () => {
  for (const path of [
    "/animal-adoptions",
    "/animal-registration",
    "/contact",
    "/faq",
    "/vet-services",
    "/animals/some-deep-path",
  ]) {
    assert.equal(getProxyAction(path, false, ON), "maintenance", path);
  }
});

// --- Maintenance page -----------------------------------------------------

test("/under-construction is allowed (no redirect loop)", () => {
  assert.equal(getProxyAction("/under-construction", false, ON), "allow");
});

// --- Admin / login --------------------------------------------------------

test("/login is allowed when enabled", () => {
  assert.equal(getProxyAction("/login", false, ON), "allow");
});

test("/admin without session still redirects to login when enabled", () => {
  // The admin session gate wins over the maintenance gate: maintenance mode
  // must never turn an unauthenticated admin request into public content.
  assert.equal(getProxyAction("/admin", false, ON), "login");
  assert.equal(getProxyAction("/admin/animals", false, ON), "login");
});

test("/admin with session is allowed when enabled", () => {
  assert.equal(getProxyAction("/admin", true, ON), "allow");
  assert.equal(getProxyAction("/admin/animals", true, ON), "allow");
});

test("admin session behavior is unchanged when disabled", () => {
  assert.equal(getProxyAction("/admin", false, OFF), "login");
  assert.equal(getProxyAction("/admin", true, OFF), "allow");
});

// --- Auth API -------------------------------------------------------------

test("auth session API is allowed when enabled", () => {
  assert.equal(getProxyAction("/api/auth/session", false, ON), "allow");
});

// --- Operational machine-to-machine APIs (#216) ----------------------------
//
// Cron + webhook routes are background infrastructure, not public
// content. Exemption only removes the maintenance redirect — each
// handler still enforces its own auth (CRON_SECRET bearer / svix
// signature), so an unauthenticated request reaches the handler and
// gets ITS 401/400/503, never a 307 to /under-construction.

test("cron routes are allowed when enabled", () => {
  assert.equal(getProxyAction("/api/cron/reminders", false, ON), "allow");
  assert.equal(getProxyAction("/api/cron/sweep-receipts", false, ON), "allow");
});

test("webhook routes are allowed when enabled", () => {
  assert.equal(getProxyAction("/api/webhooks/resend", false, ON), "allow");
});

test("future children under the ops namespaces stay exempt", () => {
  // New cron/webhook endpoints inherit the namespace exemption — the
  // point of a namespace is that the next scheduled job doesn't have
  // to remember to update this list.
  assert.equal(getProxyAction("/api/cron/some-future-job", false, ON), "allow");
  assert.equal(
    getProxyAction("/api/webhooks/some-future-provider", false, ON),
    "allow",
  );
});

test("lookalike paths are NOT exempt — prefix is slash-delimited", () => {
  for (const path of [
    "/api/cron-foo",
    "/api/cronfoo",
    "/api/webhooks-foo",
    "/api/webhooksfoo",
    "/api/cronjob",
    "/api/webhook",
  ]) {
    assert.equal(getProxyAction(path, false, ON), "maintenance", path);
  }
});

test("bare namespace roots are exempt (they 404 — no handler exists)", () => {
  // Deliberate: the namespace is uniformly ungated; a root with no
  // handler falls through to the framework 404 rather than implying a
  // public page exists behind the gate.
  assert.equal(getProxyAction("/api/cron", false, ON), "allow");
  assert.equal(getProxyAction("/api/webhooks", false, ON), "allow");
});

test("other /api paths remain gated — no blanket exemption", () => {
  assert.equal(getProxyAction("/api/anything-else", false, ON), "maintenance");
  assert.equal(getProxyAction("/api", false, ON), "maintenance");
});

test("ops API behavior is unchanged when disabled", () => {
  assert.equal(getProxyAction("/api/cron/reminders", false, OFF), "allow");
  assert.equal(getProxyAction("/api/webhooks/resend", false, OFF), "allow");
});

// --- Framework and static assets ------------------------------------------

test("Next.js framework assets are not gated", () => {
  assert.equal(
    getProxyAction("/_next/static/chunks/main.js", false, ON),
    "allow",
  );
  assert.equal(
    getProxyAction("/_next/image?url=%2Flogo.png&w=640&q=75", false, ON),
    "allow",
  );
});

test("required static assets are not gated", () => {
  for (const path of [
    "/favicon.ico",
    "/favicon.svg",
    "/favicon-16x16.png",
    "/apple-touch-icon.png",
    "/android-chrome-192x192.png",
    "/site.webmanifest",
    "/videos/hero.mp4",
    "/robots.txt",
    "/sitemap.xml",
    "/opengraph-image",
    "/twitter-image",
  ]) {
    assert.equal(getProxyAction(path, false, ON), "allow", path);
  }
});

test("exempt-path predicate agrees with the routing decision", () => {
  assert.equal(isMaintenanceExemptPath("/under-construction"), true);
  assert.equal(isMaintenanceExemptPath("/admin"), true);
  assert.equal(isMaintenanceExemptPath("/api/auth/session"), true);
  assert.equal(isMaintenanceExemptPath("/api/cron/reminders"), true);
  assert.equal(isMaintenanceExemptPath("/api/webhooks/resend"), true);
  assert.equal(isMaintenanceExemptPath("/api/cron-foo"), false);
  assert.equal(isMaintenanceExemptPath("/api/anything-else"), false);
  assert.equal(isMaintenanceExemptPath("/_next/static/app.js"), true);
  assert.equal(isMaintenanceExemptPath("/faq"), false);
  assert.equal(isMaintenanceExemptPath("/"), false);
});
