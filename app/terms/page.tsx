import type { Metadata } from "next";
import Link from "next/link";
import MobileAppShell from "@/components/MobileAppShell";
import { NON_AFFILIATION_DISCLAIMER_TEXT } from "@/lib/legalCompliance";

export const metadata: Metadata = {
  title: "Terms of Service | Prediction Whales",
  description:
    "Terms of Service and End User License Agreement for Prediction Whales.",
};

const LAST_UPDATED = "August 12, 2026";

export default function TermsPage() {
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
          <h1 className="mt-4 text-2xl font-bold text-white">
            Terms of Service
          </h1>
          <p className="mt-2 text-sm text-pulse-muted">
            End User License Agreement (EULA) · Last updated: {LAST_UPDATED}
          </p>
        </header>

        <article className="space-y-8 text-sm leading-relaxed text-pulse-muted">
          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Agreement</h2>
            <p>
              These Terms of Service (&quot;Terms&quot;) govern your access to
              and use of the Prediction Whales website, mobile applications, and
              related services (collectively, the &quot;Service&quot;). By
              accessing or using the Service, you agree to these Terms. If you do
              not agree, do not use the Service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              Informational tool only
            </h2>
            <p>
              Prediction Whales provides market data, trade alerts, expected
              value estimates, cross-market analytics, and automated insights
              derived from publicly available prediction-market information. The
              Service is for informational and educational purposes only.
            </p>
            <p>
              <strong className="text-white">
                Nothing in the Service constitutes financial, investment, tax,
                or legal advice.
              </strong>{" "}
              We are not a broker-dealer, investment adviser, or commodity
              trading advisor. You are solely responsible for your trading
              decisions and should consult qualified professionals before
              risking capital.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">No guarantees</h2>
            <p>
              Markets move quickly. Data may be delayed, incomplete, or
              inaccurate. EV metrics, AI outputs, arbitrage signals, and whale
              alerts are estimates and models — not promises of profit. Past
              performance of any trader or strategy does not guarantee future
              results.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              Eligibility &amp; compliance
            </h2>
            <p>
              You must be at least 18 years old (or the age of majority in your
              jurisdiction) to use the Service. You are responsible for ensuring
              your use complies with applicable laws, platform rules, and
              exchange terms where you trade. The Service does not facilitate
              order execution on third-party platforms.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              License &amp; acceptable use
            </h2>
            <p>
              We grant you a limited, non-exclusive, non-transferable, revocable
              license to use the Service for personal, non-commercial purposes
              unless we agree otherwise in writing. You may not scrape, resell,
              reverse engineer, or misuse the Service; attempt to bypass security;
              or use the Service to harass others or violate third-party rights.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Non-affiliation</h2>
            <p>{NON_AFFILIATION_DISCLAIMER_TEXT}</p>
            <p>
              References to Manifold, Metaculus, and other third-party platforms
              are for identification and analytics purposes only.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              Third-party platforms
            </h2>
            <p>
              The Service references data from third-party prediction market
              platforms. Your use of third-party services is governed by their
              terms and policies.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              AI-generated content
            </h2>
            <p>
              Portions of the Service use automated and AI-assisted analysis.
              Outputs may be wrong, incomplete, or outdated. Do not rely on AI
              content as the sole basis for financial decisions.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Disclaimer of warranties</h2>
            <p>
              THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS
              AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR
              IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR
              PURPOSE, AND NON-INFRINGEMENT.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">
              Limitation of liability
            </h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, PREDICTION WHALES AND ITS
              AFFILIATES WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
              SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF
              PROFITS, DATA, OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICE
              OR ANY TRADING ACTIVITY. OUR TOTAL LIABILITY FOR ANY CLAIM ARISING
              OUT OF THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF
              (A) USD $100 OR (B) THE AMOUNT YOU PAID US FOR THE SERVICE IN THE
              TWELVE MONTHS BEFORE THE CLAIM.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Indemnification</h2>
            <p>
              You agree to indemnify and hold harmless Prediction Whales from
              claims arising out of your use of the Service, your trading
              activity, or your violation of these Terms or applicable law.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Termination</h2>
            <p>
              We may suspend or terminate access to the Service at any time for
              any reason, including misuse or legal requirements. You may stop
              using the Service at any time. Sections that by nature should
              survive termination will survive.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Changes</h2>
            <p>
              We may update these Terms from time to time. Continued use after
              changes are posted constitutes acceptance of the revised Terms.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Governing law</h2>
            <p>
              These Terms are governed by the laws of the State of Delaware,
              USA, without regard to conflict-of-law principles, except where
              prohibited by mandatory local law.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-bold text-white">Contact</h2>
            <p>
              Questions about these Terms? Email{" "}
              <a
                href="mailto:privacy@predictionwhales.com"
                className="font-semibold text-pulse-accent hover:underline"
              >
                privacy@predictionwhales.com
              </a>
              . See also our{" "}
              <Link href="/privacy" className="text-pulse-accent hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </section>
        </article>
      </main>
    </MobileAppShell>
  );
}
