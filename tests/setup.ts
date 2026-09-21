import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// Node-environment suites (e.g. the client-bundle build guard in
// sentry-client-bundle.test.ts) run this file too — window only exists
// under jsdom.
if (typeof window !== "undefined") {
  // jsdom does not implement matchMedia; components check it for
  // prefers-reduced-motion. Default to "no preference".
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  // jsdom does not implement IntersectionObserver; OptimizedVideo uses
  // it for lazy loading. A no-op stub keeps tests deterministic.
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  Object.defineProperty(window, "IntersectionObserver", {
    writable: true,
    value: IntersectionObserverStub,
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    writable: true,
    value: IntersectionObserverStub,
  });

  // jsdom does not implement ResizeObserver; Radix primitives
  // (Checkbox, RadioGroup) measure themselves with it. A no-op stub is
  // sufficient.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    value: ResizeObserverStub,
  });
}
