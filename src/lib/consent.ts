import type { KlaroConfig } from "klaro/dist/klaro-no-css";

// Consent state is stored in localStorage (never sent to the server) under
// this key. Bumping `version` in the Klaro config below re-prompts visitors
// when the consent semantics change.
export const CONSENT_STORAGE_NAME = "sfpca-consent";

// The single optional service Klaro manages. GTM is the only tag-loading
// mechanism; GA4 (and any future marketing tag) lives inside the container.
export const GTM_SERVICE_NAME = "google-tag-manager";
export const GTM_SCRIPT_ID = "sfpca-gtm-script";

export interface GoogleConsentState {
  analytics_storage: "granted" | "denied";
  ad_storage: "granted" | "denied";
  ad_user_data: "granted" | "denied";
  ad_personalization: "granted" | "denied";
}

// Consent Mode v2 default: everything denied before the user chooses. The
// site runs no advertising features, so ad_* is never granted.
export const GOOGLE_CONSENT_DENIED: GoogleConsentState = {
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
};

export function googleConsentStateFor(analyticsGranted: boolean): GoogleConsentState {
  return {
    ...GOOGLE_CONSENT_DENIED,
    analytics_storage: analyticsGranted ? "granted" : "denied",
  };
}

function ensureDataLayer(win: Window): void {
  win.dataLayer = win.dataLayer || [];
  win.gtag =
    win.gtag ||
    function gtag() {
      // GCM requires pushing the arguments object itself, not an array copy.
      win.dataLayer!.push(arguments);
    };
}

// Push a Consent Mode v2 `consent update` onto the dataLayer. No-ops on the
// server and when no window is provided.
export function pushGoogleConsentUpdate(
  analyticsGranted: boolean,
  win: Window | undefined = typeof window !== "undefined" ? window : undefined,
): void {
  if (!win) return;
  ensureDataLayer(win);
  win.gtag!("consent", "update", googleConsentStateFor(analyticsGranted));
}

// Inject gtm.js exactly once. Returns true when a script was actually added.
// The DOM element persists for the page's lifetime, so the id check alone
// guarantees single injection — App Router navigation never remounts the
// layout, and repeated consent callbacks can't double-load GTM.
export function injectGtm(
  containerId: string | undefined | null,
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): boolean {
  if (!doc || !containerId || doc.getElementById(GTM_SCRIPT_ID)) return false;
  const win = doc.defaultView;
  if (win) {
    ensureDataLayer(win);
    win.dataLayer!.push({ "gtm.start": Date.now(), event: "gtm.js" });
  }
  const script = doc.createElement("script");
  script.id = GTM_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
  doc.head.appendChild(script);
  return true;
}

// Klaro invokes the service callback every time the stored consent state is
// applied — on page load (restored choice) and whenever the user changes it.
// A denial pushes a denied update so an already-loaded container stops
// collecting; an acceptance pushes the granted update and loads GTM.
export function applyAnalyticsConsent(consent: boolean): void {
  pushGoogleConsentUpdate(consent);
  if (consent) {
    injectGtm(process.env.NEXT_PUBLIC_GTM_ID);
  }
}

export function buildKlaroConfig(): KlaroConfig {
  return {
    version: 1,
    elementID: "klaro",
    storageMethod: "localStorage",
    storageName: CONSENT_STORAGE_NAME,
    default: false,
    mustConsent: false,
    acceptAll: true,
    hideDeclineAll: false,
    noticeAsModal: false,
    lang: "en",
    translations: {
      zz: {
        privacyPolicyUrl: "/privacy",
      },
      en: {
        privacyPolicyUrl: "/privacy",
        // Klaro labels the notice's affirmative button with `ok` ("That's
        // ok") even when acceptAll is on — use an explicit label instead.
        ok: "Accept",
        consentNotice: {
          description:
            "We use cookies to keep this site working. With your consent, we'd also like to use analytics to understand how the site is used. You can change your choice anytime via Cookie settings in the footer.",
          learnMore: "Customize",
        },
        consentModal: {
          title: "Privacy preferences",
          description:
            "Necessary cookies keep the site working and always stay on. Analytics is optional and only runs if you allow it.",
        },
        purposes: {
          analytics: "Analytics",
        },
        [GTM_SERVICE_NAME]: {
          title: "Google Analytics",
          description:
            "Loads Google Tag Manager, which runs Google Analytics to measure site usage. Only activates after consent.",
        },
      },
    },
    services: [
      {
        name: GTM_SERVICE_NAME,
        title: "Google Analytics",
        purposes: ["analytics"],
        required: false,
        default: false,
        optOut: false,
        onlyOnce: false,
        cookies: [/^_ga/, /^_ga_/, /^_gid/],
        callback: (consent: boolean) => applyAnalyticsConsent(consent),
      },
    ],
  };
}
