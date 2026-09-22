declare module "klaro/dist/klaro-no-css" {
  export interface KlaroService {
    name: string;
    title?: string;
    description?: string;
    purposes: string[];
    required?: boolean;
    default?: boolean;
    optOut?: boolean;
    onlyOnce?: boolean;
    cookies?: Array<string | RegExp | Array<string | RegExp>>;
    callback?: (consent: boolean, service: KlaroService) => void;
  }

  export interface KlaroConfig {
    version?: number;
    elementID?: string;
    storageMethod?: "cookie" | "localStorage" | "sessionStorage";
    storageName?: string;
    cookieExpiresAfterDays?: number;
    default?: boolean;
    mustConsent?: boolean;
    acceptAll?: boolean;
    hideDeclineAll?: boolean;
    hideLearnMore?: boolean;
    noticeAsModal?: boolean;
    disablePoweredBy?: boolean;
    noAutoLoad?: boolean;
    htmlTexts?: boolean;
    embedded?: boolean;
    groupByPurpose?: boolean;
    lang?: string;
    styling?: { theme?: string[] };
    translations?: Record<string, unknown>;
    services?: KlaroService[];
    callback?: (consent: boolean, service?: KlaroService) => void;
  }

  export interface ConsentManager {
    confirmed: boolean;
    consents: Record<string, boolean>;
    getConsent(name: string): boolean;
    setConsent(name: string, consent: boolean): void;
    saveConsents(reason?: string): void;
    applyConsents(): void;
    updateConsent(service: KlaroService, consent: boolean): void;
    watch(watcher: {
      update: (manager: ConsentManager, eventType: string, data: unknown) => void;
    }): void;
    unwatch(watcher: unknown): void;
  }

  export function setup(config: KlaroConfig): void;
  export function show(config?: KlaroConfig, modal?: boolean): boolean;
  export function getManager(config?: KlaroConfig): ConsentManager;
  export const version: string;
}

interface Window {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  klaro?: typeof import("klaro/dist/klaro-no-css");
  klaroConfig?: import("klaro/dist/klaro-no-css").KlaroConfig;
}
