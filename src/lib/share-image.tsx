// Shared renderer for the generated Open Graph / Twitter share image.
// Brand teal (hsl(174 47% 32%) → the --primary token) with the organization
// name and a factual tagline. Kept intentionally simple so it stays
// maintainable and accurate.
import { ImageResponse } from "next/og";
import { SHARE_IMAGE_ALT } from "@/lib/seo";

export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 };
export { SHARE_IMAGE_ALT };

export function renderShareImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "hsl(174, 47%, 32%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 96, fontWeight: 700, letterSpacing: 4 }}>
          SFPCA
        </div>
        <div style={{ fontSize: 36, marginTop: 16, opacity: 0.95 }}>
          Saba Foundation for Preventing Cruelty to Animals
        </div>
        <div style={{ fontSize: 26, marginTop: 24, opacity: 0.85 }}>
          Animal welfare, veterinary care, and adoption on Saba
        </div>
      </div>
    ),
    { ...SHARE_IMAGE_SIZE },
  );
}
