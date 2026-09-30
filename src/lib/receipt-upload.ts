import "server-only";

// Server-side receipt byte validation for the public upload route
// (#219 review). The route is the single byte-acceptance boundary:
// every byte of the request is counted as it arrives and the stream is
// aborted past RECEIPT_MAX_BYTES — no unbounded buffering, no
// dependence on a client-supplied Content-Length being truthful.
//
// Type enforcement inspects magic bytes rather than trusting the
// Content-Type header: a renamed executable or HTML file fails here
// even with a forged `image/png` header. The detected type — not the
// declared one — is what gets stored on the object.

import { RECEIPT_MAX_BYTES } from "./animal-registration";

export interface BoundedReadResult {
  ok: boolean;
  buffer?: Buffer;
  /** why a read was rejected — caller maps to a status code */
  reason?: "empty" | "too-large";
}

// Drain request.body with a hard byte ceiling. Returns without the
// body when the declared or streamed length exceeds the cap; partial
// bytes past the cap are discarded rather than persisted.
export async function readBoundedBody(
  request: Request,
  maxBytes: number = RECEIPT_MAX_BYTES,
): Promise<BoundedReadResult> {
  // Number(null) === 0 — guard the header's presence explicitly or
  // every request without Content-Length would read as empty.
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: "too-large" };
    }
  }

  const body = request.body;
  if (!body) return { ok: false, reason: "empty" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return { ok: false, reason: "empty" };
  return { ok: true, buffer: Buffer.concat(chunks) };
}

const PDF = "application/pdf";

// Magic-byte → canonical MIME. Covers the formats island submitters
// actually photograph receipts with (JPEG/PNG/HEIF family from phones)
// plus PDF scans.
function sniff(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return PDF;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
    return "image/png";
  if (
    buffer.subarray(0, 4).toString("latin1") === "GIF8" &&
    (buffer[4] === 0x37 || buffer[4] === 0x39)
  )
    return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (buffer.subarray(0, 2).toString("latin1") === "BM")
    return "image/bmp";
  if (
    (buffer[0] === 0x49 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x2a &&
      buffer[3] === 0x00) ||
    (buffer[0] === 0x4d &&
      buffer[1] === 0x4d &&
      buffer[2] === 0x00 &&
      buffer[3] === 0x2a)
  )
    return "image/tiff";
  // ISO BMFF family (HEIC/HEIF/AVIF) — `ftyp` brand box at offset 4.
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("latin1") === "ftyp"
  )
    return "image/heic";
  return null;
}

export function receiptTypeFamily(
  declaredType: string | null,
): "image" | "pdf" | null {
  if (!declaredType) return null;
  const t = declaredType.toLowerCase().trim();
  if (t === PDF) return "pdf";
  if (t.startsWith("image/")) return "image";
  return null;
}

// Returns the canonical detected content type to store, or null when
// the bytes do not match an allowed receipt format — or when the
// detected family contradicts the declared one (a "PDF" whose bytes
// are PNG is as untrustworthy as a PNG masquerading as a PDF).
export function detectReceiptContentType(
  buffer: Buffer,
  declaredType: string | null,
): string | null {
  const family = receiptTypeFamily(declaredType);
  if (!family) return null;
  const detected = sniff(buffer);
  if (!detected) return null;
  const detectedFamily = detected === PDF ? "pdf" : "image";
  return detectedFamily === family ? detected : null;
}
