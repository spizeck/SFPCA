import type { Metadata } from "next";
import { NOINDEX_ROBOTS } from "@/lib/seo";
import { SentryCheckPanel } from "@/components/admin/sentry-check-panel";

export const metadata: Metadata = {
  title: "Sentry Check",
  robots: NOINDEX_ROBOTS,
};

// Authorization is enforced by AdminLayout (requireAdmin → /login for
// anyone without a valid admin session). The page is not linked in the
// admin nav on purpose — it exists for the RUNBOOK §15 verification
// procedure, reached deliberately by URL.
export default function SentryCheckPage() {
  return <SentryCheckPanel />;
}
