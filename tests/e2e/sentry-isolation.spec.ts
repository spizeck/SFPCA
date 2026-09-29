// Sentry isolation guard (#235). E2E/emulator runs must never emit
// Sentry events — the resolver in src/lib/sentry.ts keeps sendEvents
// false off Vercel infrastructure, and playwright.config.ts blanks the
// DSN for the webServer. This spec proves the boundary end-to-end at
// the browser level: it aborts and counts any request to a Sentry
// ingest endpoint while exercising paths that produce expected,
// handled failures (the exact classes that previously polluted the
// production project — auth rejections and guarded admin routes).
import { expect, test } from "./fixtures";
import { E2E_APP_ORIGIN } from "./env";

test.describe("sentry isolation", () => {
  test("handled auth-boundary failures emit zero Sentry traffic", async ({
    page,
    context,
  }) => {
    // Any request the client SDK attempted — envelopes post to
    // *.ingest*.sentry.io — is counted and aborted. Zero is the only
    // acceptable count: even an attempted send means the isolation
    // boundary failed.
    let sentryRequests = 0;
    await page.route("**sentry.io**", (route) => {
      sentryRequests += 1;
      return route.abort();
    });

    // Forged session cookie: server-side verification fails and the
    // request fails closed to /login — a handled rejection, exactly the
    // kind of expected Unauthorized path that must stay out of Sentry.
    await context.addCookies([
      {
        name: "session",
        value: "forged-not-a-real-session-cookie",
        url: E2E_APP_ORIGIN,
        httpOnly: true,
      },
    ]);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);

    // Plain unauthenticated admin-route probe — another expected
    // denial.
    await page.goto("/admin/registrations");
    await expect(page).toHaveURL(/\/login/);

    // A normal public page render — no Sentry chatter at all.
    await page.goto("/");
    await expect(page).toHaveURL(`${E2E_APP_ORIGIN}/`);

    expect(sentryRequests).toBe(0);
  });
});
