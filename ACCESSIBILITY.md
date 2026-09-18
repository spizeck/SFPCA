# Accessibility

Baseline audit of the public SFPCA website against a practical WCAG 2.2 AA
target. This document records what was reviewed, what was fixed, and what
remains open. It is not a certification or a legal-compliance claim.

**Baseline date:** 2026-02-22 (Issue #88, branch `a11y/public-audit`)

## Surfaces reviewed

- `/` (hero, services, donation, "Who We Are" team carousel, FAQ preview,
  contact/map, footer)
- `/contact`, `/faq`, `/animal-adoptions`, `/animal-registration`,
  `/vet-services`, `/under-construction`, `/login`
- Shared components: breadcrumbs, theme toggle, `OptimizedVideo` background
  media, card/radio/checkbox primitives, Framer Motion entrance animations

No consent/Klaro UI exists on `main`, so none was audited.

## Automated tooling

- `@axe-core/playwright` `4.13.x` — axe-core scans per public route with
  tags `wcag2a/wcag2aa/wcag21a/wcag21aa/wcag22aa`, plus a dark-theme scan of
  the homepage. See `tests/e2e/accessibility.spec.ts`.
- The suite fails on **critical** or **serious** violations; moderate/minor
  findings are attached to the test report for triage rather than failing
  the build. No axe rules are globally disabled.

### Baseline findings (before remediation)

| Route | Findings |
| --- | --- |
| `/` | 4 critical `button-name` (carousel prev/next, pagination dots, FAQ chevron), 3 serious `color-contrast` (muted text on muted/foreground backgrounds), 2 serious `target-size` (8px pagination dots) |
| `/faq` | 1 serious `color-contrast` (muted text on muted section) |
| `/animal-adoptions` | 3 serious `color-contrast` (section subtitles on muted/secondary) |
| `/vet-services` | 1 serious `color-contrast` (CTA subtitle on secondary) |
| `/under-construction` | 2 serious `color-contrast` (contact details on muted box) |
| `/contact`, `/animal-registration`, `/login` | none |

## Manual checks performed

- Keyboard-only pass over every public route: tab order, menu/accordion
  operation, form reachability, activation with Enter/Space.
- Focus visibility on buttons, links, form controls, carousel controls,
  theme toggle, breadcrumb nav (light and dark themes).
- `prefers-reduced-motion` emulation: entrance animations, carousel
  auto-rotation, background-video autoplay.
- Mobile viewport (~375px) and ~200% zoom/reflow on representative pages.

## Issues found and fixed

- **Skip navigation** — added a "Skip to main content" link (visible on
  focus) in the root layout; every public `<main>` now has
  `id="main-content"` and `tabindex="-1"` so focus actually moves.
- **Landmarks/headings** — `/under-construction` and `/login` used plain
  `<div>` wrappers and card titles instead of `main`/`h1`; corrected.
  Category titles on `/faq` and the registration-form title adjusted so
  heading levels don't skip.
- **FAQ accordions (page + homepage preview)** — the clickable
  `CardHeader` divs were unreachable by keyboard; replaced with native
  `<button>` toggles exposing `aria-expanded`/`aria-controls` and a
  labelled answer `role="region"`.
- **Team carousel** — added accessible names to previous/next controls,
  a pause/resume control (`aria-pressed`) for the 5s auto-rotation,
  labelled pagination buttons with ≥24px hit areas and `aria-current`,
  `role="group"` + `aria-roledescription="carousel"`/`"slide"`, and
  reduced-motion guards on rotation and slide transitions.
- **Contrast** — `text-muted-foreground` on `bg-muted`/`bg-secondary`/
  `bg-foreground` backgrounds failed AA; replaced with `text-foreground/80`
  (or `text-background/80` in the footer) at the flagged spots. Brand
  colors unchanged.
- **Forms** — registration: `autocomplete` on owner fields
  (name/street-address/tel/email), radio groups wrapped in
  `fieldset`/`legend` with semantic `required`, help text associated via
  `aria-describedby`, decorative asterisks hidden from AT, per-animal
  "Remove" buttons disambiguated. Login: `autocomplete` email/current-/
  new-password.
- **Media** — decorative background videos are `aria-hidden`,
  non-focusable, and no longer autoplay when reduced motion is requested.
  Both map iframes got a `title`.
- **Semantics** — fake "• " paragraphs converted to real lists; breadcrumb
  nav labelled with `aria-label="Breadcrumb"` and `aria-current="page"`;
  decorative icons/emojis marked `aria-hidden`.
- **Reduced motion** — Framer Motion `y`-offset entrance animations across
  public pages now check `shouldReduceMotion()`; carousel auto-rotation
  and video autoplay respect the preference.

## Known exceptions / follow-ups

- **No custom validation summary** on the registration form — it relies on
  native `required` + browser validation UI, which focuses the offending
  control. A richer error summary is a possible enhancement, not a
  baseline defect.
- **Admin area** was not audited (separate scope); the shared skip link
  and `main` landmark do benefit it.
- **Carousel slide announcements** rely on `aria-label` per slide rather
  than a live region — an auto-rotating live region would spam screen
  readers; pausing is provided instead.
- FAQ content is loaded from Firestore; if no FAQs exist the accordion
  renders nothing (page shows an empty-state message instead).
