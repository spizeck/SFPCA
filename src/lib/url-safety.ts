// Render-boundary safety for URLs that come from stored CMS content.
//
// Firestore page-content and siteSettings documents are admin-written but
// unvalidated (see src/lib/page-content.ts), and the siteSettings write
// path is a client-SDK setDoc no server code ever inspects. Anything a CMS
// field can hold — including a `javascript:` or `data:` URL pasted by a
// compromised or misled admin session — therefore reaches the public site
// verbatim unless the render path filters it.
//
// These helpers are the filter: they accept only absolute http(s) URLs and
// return null for everything else, so callers can hide the control rather
// than emit a dangerous attribute. They are pure and client-safe — import
// them from any component.

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    // No base URL: relative paths and scheme-relative input must fail.
    return new URL(trimmed);
  } catch {
    return null;
  }
}

// http/https absolute URLs only — `javascript:`, `data:`, `vbscript:`,
// `file:`, protocol-relative (`//host`), and malformed input all return
// null. For navigation targets (social links) where http is still a sane
// (if outdated) value.
export function safeExternalUrl(value: unknown): string | null {
  const url = parseHttpUrl(value);
  if (!url) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}

// Stricter variant for <iframe src>: https only. Besides scriptable
// schemes, a plaintext-http frame would be blocked as mixed content on
// the https site anyway — and an encrypted embed is the only kind that
// can't be rewritten in transit.
export function safeEmbedUrl(value: unknown): string | null {
  const url = parseHttpUrl(value);
  if (!url || url.protocol !== "https:") return null;
  return url.toString();
}
