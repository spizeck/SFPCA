"use client";

import { useEffect } from "react";

// Warns before navigation that would silently discard unsaved edits
// (#91). Two vectors are covered:
//
// - Tab close / reload / external navigation: the `beforeunload`
//   browser prompt.
// - In-app navigation: App Router has no router event API, so a
//   capture-phase click listener intercepts same-tab anchor clicks
//   (admin nav, breadcrumbs, in-page links) and confirms with the user.
//   Links opening in a new tab, downloads, and non-navigating schemes
//   (mailto:, tel:, #) are never intercepted.
//
// Deliberately not covered: programmatic router.push() calls (e.g.
// Logout) — there is no supported interception point, and bolting one
// on is not worth the machinery for an edge case.
export function useUnsavedChangesGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
        return;
      }
      const href = anchor.getAttribute("href") ?? "";
      if (/^(mailto:|tel:|#)/i.test(href)) return;
      if (
        !window.confirm(
          "You have unsaved changes. Leave this page and lose them?",
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);
}
