import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  GOOGLE_CONSENT_DENIED,
  googleConsentStateFor,
  pushGoogleConsentUpdate,
  injectGtm,
  applyAnalyticsConsent,
  buildKlaroConfig,
  CONSENT_STORAGE_NAME,
  GTM_SERVICE_NAME,
  GTM_SCRIPT_ID,
} from "@/lib/consent";
import { ConsentSettingsButton } from "@/components/consent/consent-settings-button";

const klaroMocks = vi.hoisted(() => ({
  setup: vi.fn(),
  show: vi.fn(),
  getManager: vi.fn(),
}));

vi.mock("klaro/dist/klaro-no-css", () => {
  const api = {
    setup: klaroMocks.setup,
    show: klaroMocks.show,
    getManager: klaroMocks.getManager,
    version: "0.7.21",
  };
  // The real bundle is UMD: bundlers expose it via `default`, so the mock
  // must too (the component reads `mod.default ?? mod`).
  return { ...api, default: api };
});

function gtmScripts(doc: Document = document): HTMLScriptElement[] {
  return Array.from(
    doc.querySelectorAll<HTMLScriptElement>(`script#${GTM_SCRIPT_ID}`),
  );
}

// gtag() pushes `arguments` objects (array-like, not Array) — normalize for
// comparison.
function consentEntries(): unknown[][] {
  return (window.dataLayer ?? [])
    .filter(
      (e): e is ArrayLike<unknown> =>
        e != null &&
        typeof e === "object" &&
        (e as ArrayLike<unknown>)[0] === "consent",
    )
    .map((e) => Array.from(e));
}

beforeEach(() => {
  gtmScripts().forEach((s) => s.remove());
  window.dataLayer = undefined;
  window.gtag = undefined;
  delete window.klaro;
  delete window.klaroConfig;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterEach(() => {
  gtmScripts().forEach((s) => s.remove());
  window.dataLayer = undefined;
  window.gtag = undefined;
});

describe("googleConsentStateFor", () => {
  it("denies everything when analytics is not consented", () => {
    expect(googleConsentStateFor(false)).toEqual({
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });

  it("grants only analytics_storage when consented — ads stay denied", () => {
    expect(googleConsentStateFor(true)).toEqual({
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  });
});

describe("pushGoogleConsentUpdate", () => {
  it("creates dataLayer/gtag and pushes a consent update", () => {
    pushGoogleConsentUpdate(true);
    expect(consentEntries()).toEqual([
      ["consent", "update", googleConsentStateFor(true)],
    ]);
  });

  it("no-ops without a window", () => {
    expect(() => pushGoogleConsentUpdate(true, undefined)).not.toThrow();
  });
});

describe("injectGtm", () => {
  it("does nothing without a container id", () => {
    expect(injectGtm(undefined)).toBe(false);
    expect(injectGtm("")).toBe(false);
    expect(gtmScripts()).toHaveLength(0);
  });

  it("injects gtm.js once and pushes gtm.start", () => {
    expect(injectGtm("GTM-TEST123")).toBe(true);
    expect(gtmScripts()).toHaveLength(1);
    expect(gtmScripts()[0].src).toBe(
      "https://www.googletagmanager.com/gtm.js?id=GTM-TEST123",
    );
    expect(gtmScripts()[0].async).toBe(true);
    expect(window.dataLayer).toContainEqual(
      expect.objectContaining({ event: "gtm.js" }),
    );
  });

  it("never injects a second script (App Router navigation / repeated calls)", () => {
    expect(injectGtm("GTM-TEST123")).toBe(true);
    expect(injectGtm("GTM-TEST123")).toBe(false);
    expect(gtmScripts()).toHaveLength(1);
  });

  it("recognizes an existing gtm script element as already loaded", () => {
    const pre = document.createElement("script");
    pre.id = GTM_SCRIPT_ID;
    document.head.appendChild(pre);
    expect(injectGtm("GTM-TEST123")).toBe(false);
    expect(gtmScripts()).toHaveLength(1);
  });
});

describe("applyAnalyticsConsent", () => {
  it("denied: pushes denied update, never injects GTM", () => {
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-TEST123");
    applyAnalyticsConsent(false);
    expect(consentEntries()).toEqual([
      ["consent", "update", googleConsentStateFor(false)],
    ]);
    expect(gtmScripts()).toHaveLength(0);
  });

  it("granted: pushes granted update and injects GTM", () => {
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-TEST123");
    applyAnalyticsConsent(true);
    expect(consentEntries()).toEqual([
      ["consent", "update", googleConsentStateFor(true)],
    ]);
    expect(gtmScripts()).toHaveLength(1);
  });

  it("granted but GTM unconfigured: consent updates, no script, no throw", () => {
    applyAnalyticsConsent(true);
    expect(consentEntries()).toHaveLength(1);
    expect(gtmScripts()).toHaveLength(0);
  });

  it("declining after acceptance pushes a denied update", () => {
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-TEST123");
    applyAnalyticsConsent(true);
    applyAnalyticsConsent(false);
    expect(consentEntries()[1]).toEqual([
      "consent",
      "update",
      googleConsentStateFor(false),
    ]);
    expect(consentEntries()).toHaveLength(2);
  });
});

describe("buildKlaroConfig", () => {
  it("stores consent in localStorage under the versioned site key", () => {
    const config = buildKlaroConfig();
    expect(config.storageMethod).toBe("localStorage");
    expect(config.storageName).toBe(CONSENT_STORAGE_NAME);
    expect(config.version).toBe(1);
  });

  it("defaults everything off and never forces consent", () => {
    const config = buildKlaroConfig();
    expect(config.default).toBe(false);
    expect(config.mustConsent).toBe(false);
    expect(config.noticeAsModal).toBe(false);
    expect(config.hideDeclineAll).toBe(false);
    expect(config.acceptAll).toBe(true);
  });

  it("manages a single optional analytics service", () => {
    const [service] = buildKlaroConfig().services!;
    expect(service.name).toBe(GTM_SERVICE_NAME);
    expect(service.purposes).toEqual(["analytics"]);
    expect(service.required).toBe(false);
    expect(service.default).toBe(false);
    expect(service.optOut).toBe(false);
    expect(service.onlyOnce).toBe(false);
    expect(typeof service.callback).toBe("function");
  });

  it("service callback routes through the consent boundary", () => {
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-TEST123");
    const [service] = buildKlaroConfig().services!;
    service.callback!(true, service);
    expect(consentEntries()).toEqual([
      ["consent", "update", googleConsentStateFor(true)],
    ]);
    expect(gtmScripts()).toHaveLength(1);
  });

  it("links the privacy policy from the notice and modal", () => {
    const t = buildKlaroConfig().translations as Record<
      string,
      { privacyPolicyUrl?: string }
    >;
    expect(t.en.privacyPolicyUrl).toBe("/privacy");
    expect(t.zz.privacyPolicyUrl).toBe("/privacy");
  });
});

describe("ConsentManager", () => {
  // `klaroInitialized` is module-level state in the component — re-import a
  // fresh module per test so mounts actually exercise the one-time guard
  // instead of inheriting the flag from an earlier test.
  async function freshConsentManager() {
    vi.resetModules();
    return (await import("@/components/consent/consent-manager"))
      .ConsentManager;
  }

  it("initializes Klaro once and exposes it for the settings control", async () => {
    const ConsentManager = await freshConsentManager();
    render(<ConsentManager />);
    await waitFor(() => expect(klaroMocks.setup).toHaveBeenCalledTimes(1));
    expect(klaroMocks.setup).toHaveBeenCalledWith(
      expect.objectContaining({ storageName: CONSENT_STORAGE_NAME }),
    );
    expect(window.klaro).toBeDefined();
    expect(window.klaroConfig).toBeDefined();
  });

  it("does not re-run setup on a second mount", async () => {
    const ConsentManager = await freshConsentManager();
    render(<ConsentManager />);
    await waitFor(() => expect(klaroMocks.setup).toHaveBeenCalledTimes(1));
    render(<ConsentManager />);
    await new Promise((r) => setTimeout(r, 50));
    expect(klaroMocks.setup).toHaveBeenCalledTimes(1);
  });

  it("renders nothing into the React tree — Klaro owns its own DOM", async () => {
    const ConsentManager = await freshConsentManager();
    const { container } = render(<ConsentManager />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ConsentSettingsButton", () => {
  it("reopens the Klaro modal when clicked", () => {
    const config = buildKlaroConfig();
    window.klaro = { show: klaroMocks.show } as never;
    window.klaroConfig = config;
    render(<ConsentSettingsButton />);
    fireEvent.click(screen.getByRole("button", { name: /cookie settings/i }));
    expect(klaroMocks.show).toHaveBeenCalledWith(config, true);
  });

  it("is a harmless no-op before Klaro loads", () => {
    render(<ConsentSettingsButton />);
    expect(() =>
      fireEvent.click(
        screen.getByRole("button", { name: /cookie settings/i }),
      ),
    ).not.toThrow();
    expect(klaroMocks.show).not.toHaveBeenCalled();
  });
});

describe("Sentry separation", () => {
  it("the consent module never references Sentry — consent choices cannot alter error monitoring", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/lib/consent.ts"),
      "utf8",
    ).toLowerCase();
    expect(src).not.toContain("sentry");
  });
});
