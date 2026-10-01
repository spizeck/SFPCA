import { describe, expect, it } from "vitest";
import { safeEmbedUrl, safeExternalUrl } from "@/lib/url-safety";

describe("safeExternalUrl", () => {
  it.each([
    "https://facebook.com/sfpca",
    "http://example.com/legacy",
    "https://example.com/path?q=1#frag",
    "  https://example.com/trimmed  ",
  ])("accepts %s", (value) => {
    expect(safeExternalUrl(value)).toBe(value.trim());
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.com/protocol-relative",
    "example.com/no-scheme",
    "https://",
    "not a url",
    "",
    "   ",
  ])("rejects %j", (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });

  it.each([undefined, null, 42, {}, ["https://x"]])(
    "rejects non-string %j",
    (value) => {
      expect(safeExternalUrl(value)).toBeNull();
    },
  );
});

describe("safeEmbedUrl", () => {
  it("accepts absolute https URLs", () => {
    const url = "https://www.google.com/maps/embed?pb=abc123";
    expect(safeEmbedUrl(url)).toBe(url);
  });

  it.each([
    "http://www.google.com/maps/embed",
    "javascript:alert(1)",
    "data:text/html,<h1>hi</h1>",
    "//www.google.com/maps/embed",
    "www.google.com/maps/embed",
    "",
  ])("rejects %j", (value) => {
    expect(safeEmbedUrl(value)).toBeNull();
  });
});
