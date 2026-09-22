import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/privacy",
  title: "Privacy Policy",
  description:
    "How the SFPCA website handles cookies, analytics consent, and error monitoring.",
});

export default function PrivacyPage() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen">
      <div className="container mx-auto px-4 py-16 max-w-3xl">
        <h1 className="text-4xl font-bold mb-8">Privacy Policy</h1>

        <section className="space-y-4 mb-10">
          <h2 className="text-2xl font-semibold">Cookies and consent</h2>
          <p>
            This site uses a consent banner (Klaro, an open-source consent
            manager) to let you control optional cookies and tracking. Your
            choice is stored in your browser&apos;s local storage under the key{" "}
            <code>sfpca-consent</code> and stays on your device — it is never
            sent to us.
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong>Necessary</strong> — required for the site to work (for
              example, staying signed in). These are always on.
            </li>
            <li>
              <strong>Analytics</strong> — optional. If you accept, Google Tag
              Manager loads and runs Google Analytics to measure how the site
              is used. If you decline or simply close the banner, nothing
              optional is loaded.
            </li>
          </ul>
          <p>
            You can change your choice at any time using the{" "}
            <em>Cookie settings</em> link in the footer.
          </p>
          <p>
            The contact section embeds a Google Maps map, which loads content
            from Google to display our location; it is shown as part of the
            site&apos;s core content, not for analytics.
          </p>
        </section>

        <section className="space-y-4 mb-10">
          <h2 className="text-2xl font-semibold">Error monitoring</h2>
          <p>
            Separately from analytics, the site uses Sentry to detect
            unexpected technical errors so we can fix them. Error reports are
            stripped of personal data (cookies, tokens, form contents, and
            account identifiers are removed before anything is sent) and are
            not used for marketing. This operational monitoring is not part of
            the analytics consent choice.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-semibold">Questions</h2>
          <p>
            For questions about your data — including anything submitted
            through registration or contact forms — please reach out via the{" "}
            <a href="/contact" className="text-primary underline underline-offset-4">
              contact page
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
