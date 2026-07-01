import { ArrowRight, Code2, LockKeyhole, Network, RefreshCcw, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { Badge, CheckItem, Panel } from "@eliteconverter/ui";
import { responsibleUseNotice } from "@eliteconverter/shared";
import { ConversionForm } from "../components/ConversionForm";
import { usePageTitle } from "./hooks";

export default function Landing() {
  usePageTitle("EliteConverter - Convert Streams. Deliver Anywhere.");
  return (
    <>
      <section className="hero-section">
        <div className="hero-copy">
          <Badge tone="success">Provider-backed conversion API</Badge>
          <h1>EliteConverter</h1>
          <p className="lede">Convert Streams. Deliver Anywhere.</p>
          <p>{responsibleUseNotice}</p>
          <div className="hero-actions">
            <Link className="primary-link" to="/docs/getting-started">
              Developer docs <ArrowRight aria-hidden="true" />
            </Link>
            <Link className="secondary-link" to="/status">
              System status
            </Link>
          </div>
        </div>
        <ConversionForm />
      </section>

      <section className="content-band">
        <div className="section-head">
          <h2>Supported outputs</h2>
          <p>
            Capabilities come from configured providers and are reflected in the conversion form.
          </p>
        </div>
        <div className="pill-grid" aria-label="Supported formats">
          {[
            "MP4",
            "WebM",
            "MKV",
            "MP3",
            "M4A",
            "Source",
            "1080p",
            "720p",
            "480p",
            "Audio only",
          ].map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </section>

      <section className="workflow-section">
        <Panel>
          <Network aria-hidden="true" className="panel-icon" />
          <h2>Three-step workflow</h2>
          <ol className="steps">
            <li>Submit an authorized media URL.</li>
            <li>Queue processing sends the job to an eligible provider.</li>
            <li>Poll status or receive a signed webhook when output is ready.</li>
          </ol>
        </Panel>
        <Panel>
          <Code2 aria-hidden="true" className="panel-icon" />
          <h2>Developer API</h2>
          <ul className="check-list">
            <CheckItem>Versioned `/api/v1` routes</CheckItem>
            <CheckItem>Idempotency keys</CheckItem>
            <CheckItem>Signed client webhooks</CheckItem>
          </ul>
        </Panel>
      </section>

      <section className="content-band split-band">
        <div>
          <RefreshCcw aria-hidden="true" className="section-icon" />
          <h2>Reliability and fallback</h2>
          <p>
            Provider health, retry classification, circuit breakers and scheduled reconciliation
            reduce failed handoffs without claiming availability that depends on upstream sources
            and conversion vendors.
          </p>
        </div>
        <div>
          <LockKeyhole aria-hidden="true" className="section-icon" />
          <h2>Security controls</h2>
          <p>
            SSRF validation, rate limits, API-key hashing, Turnstile validation, CORS restrictions,
            redacted logs and signed webhooks are built into the request path.
          </p>
        </div>
      </section>

      <section className="faq-section">
        <h2>FAQ</h2>
        <details>
          <summary>Does the Worker transcode video?</summary>
          <p>
            No. Cloudflare Workers coordinate jobs and providers. Native transcoding belongs in
            authorized external services.
          </p>
        </details>
        <details>
          <summary>Can I process protected platform content?</summary>
          <p>
            No. DRM-protected content, paywall bypass and access-control circumvention are not
            supported.
          </p>
        </details>
        <details>
          <summary>Can I run this without provider credentials?</summary>
          <p>Yes. The mock provider supports deterministic local and test flows.</p>
        </details>
      </section>

      <section className="final-cta">
        <ShieldCheck aria-hidden="true" />
        <h2>Build with the mock provider, then connect an authorized provider.</h2>
        <Link className="primary-link" to="/convert">
          Open converter <ArrowRight aria-hidden="true" />
        </Link>
      </section>
    </>
  );
}
