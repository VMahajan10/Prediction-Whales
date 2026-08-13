import type { Metadata } from "next";
import Link from "next/link";
import MobileAppShell from "@/components/MobileAppShell";
import DataDeletionRequest from "@/components/DataDeletionRequest";
import { DATA_SOURCE_INGESTION_DISCLOSURE_TEXT, NON_AFFILIATION_DISCLAIMER_TEXT } from "@/lib/legalCompliance";

export const metadata: Metadata = {
  title: "Privacy Policy | Prediction Whales",
  description:
    "How Prediction Whales collects, uses, and protects your information.",
};

const LAST_UPDATED = "August 12, 2026";

export default function PrivacyPolicyPage() {
  return (
    <MobileAppShell showNav={false}>
      <main className="min-h-screen px-4 py-8 pb-12">
        <header className="mb-8">
          <Link
            href="/"
            className="text-sm font-semibold text-pulse-accent hover:underline"
          >
            ← Back to feed
          </Link>
          <h1 className="mt-4 text-2xl font-bold text-white">Privacy Policy</h1>
          <p className="mt-2 text-sm text-pulse-muted">
            Last updated: {LAST_UPDATED}
          </p>
        </header>

        <article className="space-y-8 text-sm leading-relaxed text-pulse-muted">
          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Overview</h2>
            <p>
              Prediction Whales (&quot;we,&quot; &quot;us,&quot; or
              &quot;our&quot;) provides market intelligence for prediction
              markets, including whale trade alerts and analytics. This policy
              explains what information we process when you use our website and
              mobile applications (collectively, the &quot;Service&quot;).
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              Information we collect
            </h2>
            <p>{DATA_SOURCE_INGESTION_DISCLOSURE_TEXT}</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-white">Public market data.</strong> We
                ingest publicly available trade and market data from third-party
                platforms (e.g., Polymarket, Kalshi) to power feeds, analytics,
                and alerts. This data is not private user account information
                from those platforms.
              </li>
              <li>
                <strong className="text-white">Wallet and trader identifiers.</strong>{" "}
                When you view or follow traders, we may process public wallet
                addresses and pseudonyms associated with on-chain or
                platform-visible activity.
              </li>
              <li>
                <strong className="text-white">Device and usage data.</strong>{" "}
                Our hosting provider may log standard technical information
                (IP address, browser or app user agent, timestamps, and pages
                requested) for security, reliability, and performance.
              </li>
              <li>
                <strong className="text-white">Local preferences.</strong>{" "}
                Settings such as bookmarks, alerts, and UI preferences may be
                stored in your browser or device local storage. This data stays
                on your device unless you clear it or we sync it as part of a
                signed-in feature.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              How we use information
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>Operate, maintain, and improve the Service</li>
              <li>Display whale trades, expected value signals, and analytics</li>
              <li>Send alerts and notifications you opt into</li>
              <li>Protect against abuse, fraud, and security incidents</li>
              <li>Comply with legal obligations</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              Third-party services
            </h2>
            <p>
              We rely on infrastructure and data providers to run the Service,
              which may process limited technical or operational data on our
              behalf. These can include hosting (e.g., Vercel), databases,
              caching, analytics, and AI inference providers used to generate
              market insights. Each provider is used only to deliver the
              Service.
            </p>
            <p>
              The Service links to or displays content from external prediction
              market platforms. Their privacy practices apply when you leave our
              app or interact with those platforms directly.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Data sharing</h2>
            <p>
              We do not sell your personal information. We may share information
              only with service providers who help us operate the Service, when
              required by law, or to protect rights, safety, and security.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Data retention</h2>
            <p>
              We retain information only as long as needed to provide the
              Service, meet legal requirements, resolve disputes, and enforce
              our agreements. Aggregated or de-identified analytics may be kept
              longer.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Your choices</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Clear local preferences by removing app data or browser storage
              </li>
              <li>Disable notifications in your device or browser settings</li>
              <li>
                Contact us to request access, correction, or deletion where
                applicable law provides those rights
              </li>
            </ul>
          </section>

          <section>
            <DataDeletionRequest />
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Children</h2>
            <p>
              The Service is not directed to children under 13 (or the minimum
              age required in your jurisdiction). We do not knowingly collect
              personal information from children.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              International users
            </h2>
            <p>
              If you access the Service from outside the United States, your
              information may be processed in the United States or other
              countries where our providers operate.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Non-affiliation</h2>
            <p>{NON_AFFILIATION_DISCLAIMER_TEXT}</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Changes</h2>
            <p>
              We may update this policy from time to time. We will revise the
              &quot;Last updated&quot; date above when changes are posted.
              Continued use of the Service after an update means you accept the
              revised policy.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Contact</h2>
            <p>
              Questions about this policy or your data? Email us at{" "}
              <a
                href="mailto:privacy@predictionwhales.com"
                className="font-semibold text-pulse-accent hover:underline"
              >
                privacy@predictionwhales.com
              </a>
              . See our{" "}
              <Link href="/terms" className="text-pulse-accent hover:underline">
                Terms of Service
              </Link>
              .
            </p>
          </section>
        </article>
      </main>
    </MobileAppShell>
  );
}
