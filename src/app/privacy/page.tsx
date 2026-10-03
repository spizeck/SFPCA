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
          <h2 className="text-2xl font-semibold">Registration data retention</h2>
          <p>
            When you register an animal with SFPCA we keep your
            information only for defined periods:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong>Completed registrations and payments</strong> —
              kept for 7 years after the end of the registration year
              they belong to. After that, the personal details on the
              original submission are removed while the animal&apos;s
              registration and payment history is kept as part of the
              registry&apos;s records.
            </li>
            <li>
              <strong>Payment receipts</strong> — the receipt file you
              upload is used to verify and reconcile your payment, then
              deleted 90 days after it has been verified. The payment
              itself — amount, date, and status — stays on record.
            </li>
            <li>
              <strong>Registrations that were never completed</strong> —
              a submission that is left unfinished or is not approved is
              kept for up to 12 months and then deleted.
            </li>
            <li>
              <strong>Animal and owner records</strong> — your
              animal&apos;s registry entry and its ownership, licensing,
              and veterinary history may be kept while they are needed
              to provide SFPCA services and maintain accurate animal
              records.
            </li>
            <li>
              <strong>Exceptions</strong> — some information may be kept
              longer when necessary for a legal obligation, an active
              dispute, a fraud or security investigation, an accounting
              or audit requirement, or another documented record-keeping
              need.
            </li>
          </ul>
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
          <h2 className="text-2xl font-semibold">Questions and requests</h2>
          <p>
            To ask about your data — including access, correction, or
            deletion of your personal information, subject to the records
            SFPCA needs to keep — please reach out via the{" "}
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
