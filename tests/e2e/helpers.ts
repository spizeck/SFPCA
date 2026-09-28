// Shared Playwright helpers for the emulator-backed e2e suite.
import { expect, type Locator, type Page } from "@playwright/test";

// Mirrors CONSENT_STORAGE_NAME in src/lib/consent.ts — kept as a literal so
// e2e helpers stay independent of app internals.
const CONSENT_KEY = "sfpca-consent";

// The Klaro consent notice mounts asynchronously after hydration and
// auto-focuses itself (correct dialog behavior). Tests that exercise the
// page itself dismiss it deterministically so it can't intercept pointer
// events, shift focus, or satisfy `getByRole("dialog")` locators meant for
// app dialogs.
export async function dismissConsentNotice(page: Page): Promise<void> {
  const notice = page.locator(".cookie-notice");
  // Once consent is stored (earlier navigation in the same context) the
  // notice never mounts — skip the wait rather than burn a timeout.
  const stored = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    CONSENT_KEY,
  );
  if (stored !== null) return;
  const appeared = await notice
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  // The Next dev overlay can cover the bottom-right notice buttons in small
  // viewports and intercept the pointer — dispatch directly on the button.
  await notice
    .getByRole("button", { name: "I decline" })
    .dispatchEvent("click");
  await expect(notice).toBeHidden();
}

// A freshly mounted Radix dialog animates in (~200ms translate/scale).
// Playwright's actionability check can pass during a janky frame pair
// under load, then the dispatched pointer events land where the button
// WAS — on inert dialog chrome — and the click is silently swallowed
// (observed: the merge-confirmation dialog stayed open and armed after
// a "successful" click). Synchronize on the platform truth — no finite
// animation still running on the dialog subtree — before interacting.
export async function waitForDialogSettled(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await dialog.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter(
          (a) =>
            a.playState !== "finished" &&
            a.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((a) => a.finished.catch(() => {})),
    ),
  );
}
