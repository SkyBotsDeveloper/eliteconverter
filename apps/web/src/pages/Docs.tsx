import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-http";
import "prismjs/components/prism-json";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-python";
import "prismjs/themes/prism-tomorrow.css";
import { usePageTitle } from "./hooks";

interface DocsProps {
  page: DocsPageKey;
}

type DocsPageKey =
  | "overview"
  | "getting-started"
  | "authentication"
  | "conversions"
  | "job-status"
  | "errors"
  | "webhooks"
  | "examples"
  | "limits";

const docsNav: Array<{ key: DocsPageKey; to: string; label: string }> = [
  { key: "overview", to: "/docs", label: "Overview" },
  { key: "getting-started", to: "/docs/getting-started", label: "Getting started" },
  { key: "authentication", to: "/docs/authentication", label: "Authentication" },
  { key: "conversions", to: "/docs/conversions", label: "Conversions" },
  { key: "job-status", to: "/docs/job-status", label: "Job status" },
  { key: "errors", to: "/docs/errors", label: "Errors" },
  { key: "webhooks", to: "/docs/webhooks", label: "Webhooks" },
  { key: "examples", to: "/docs/examples", label: "Examples" },
  { key: "limits", to: "/docs/limits", label: "Limits" },
];

export default function Docs({ page }: DocsProps) {
  const [query, setQuery] = useState("");
  const content = docsContent[page];
  usePageTitle(`${content.title} - EliteConverter Docs`);

  useEffect(() => {
    Prism.highlightAll();
  }, [page]);

  const filtered = useMemo(
    () => docsNav.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  return (
    <section className="docs-layout">
      <aside className="docs-sidebar">
        <label className="ec-field" htmlFor="docs-search">
          <span>Search docs</span>
          <input
            id="docs-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav aria-label="Documentation navigation">
          {filtered.map((item) => (
            <NavLink key={item.key} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <article className="docs-content">
        <h1>{content.title}</h1>
        {content.body}
        <footer className="docs-footer">
          <p>Created by Siddhartha Abhimanyu</p>
          <p>
            <a href="https://t.me/iflexsid">Telegram @iflexsid</a> ·{" "}
            <a href="https://instagram.com/elite.sid">Instagram elite.sid</a>
          </p>
          <Link to="/acceptable-use">Acceptable Use Policy</Link>
        </footer>
      </article>
    </section>
  );
}

const Code = ({ language, children }: { language: string; children: string }) => (
  <pre>
    <code className={`language-${language}`}>{children.trim()}</code>
  </pre>
);

const docsContent: Record<DocsPageKey, { title: string; body: ReactNode }> = {
  overview: {
    title: "EliteConverter API",
    body: (
      <>
        <p>
          EliteConverter accepts authorized, provider-supported media URLs, creates asynchronous
          jobs, submits them to provider adapters and returns safe public status objects. M3U8 is
          unavailable until an operator verifies a capable provider in staging.
        </p>
        <Code language="http">{`
GET /api/v1/health
GET /api/v1/capabilities
POST /api/v1/conversions
GET /api/v1/conversions/:jobId
GET /api/v1/conversions/:jobId/download
POST /api/v1/conversions/:jobId/cancel
        `}</Code>
      </>
    ),
  },
  "getting-started": {
    title: "Getting Started",
    body: (
      <>
        <ol className="steps">
          <li>Run local D1 migrations.</li>
          <li>Create a test API key with `pnpm api-key:create`.</li>
          <li>Submit a conversion using the mock provider.</li>
        </ol>
        <Code language="bash">{`
corepack pnpm install --frozen-lockfile
corepack pnpm db:migrate:local
corepack pnpm api-key:create -- --name local-test
corepack pnpm dev
        `}</Code>
      </>
    ),
  },
  authentication: {
    title: "Authentication",
    body: (
      <>
        <p>Private API routes use bearer tokens with the `ec_live_` or `ec_test_` prefix.</p>
        <Code language="http">{`
POST /api/v1/conversions
Authorization: Bearer ec_test_xxxxxxxxx
Content-Type: application/json
Idempotency-Key: customer-request-001
        `}</Code>
        <p>Raw keys are displayed once. Only HMAC hashes are stored.</p>
      </>
    ),
  },
  conversions: {
    title: "Conversions",
    body: (
      <>
        <Code language="json">{`
{
  "url": "https://example.com/input.mp4",
  "format": "mp4",
  "quality": "source",
  "callbackUrl": "https://client.example.com/webhooks/eliteconverter"
}
        `}</Code>
        <p>Use `Idempotency-Key` to safely retry equivalent create requests.</p>
      </>
    ),
  },
  "job-status": {
    title: "Job Status",
    body: (
      <>
        <p>Jobs move through queued, submitting, processing, retrying and terminal statuses.</p>
        <Code language="json">{`
{
  "jobId": "ec_job_xxxxxxxxx",
  "status": "completed",
  "progress": 100,
  "outputMimeType": "video/mp4"
}
        `}</Code>
        <p>Use the protected download endpoint to retrieve the private signed output URL.</p>
      </>
    ),
  },
  errors: {
    title: "Errors",
    body: (
      <>
        <p>Errors are safe to show to users and include retryability.</p>
        <Code language="json">{`
{
  "success": false,
  "error": {
    "code": "invalid_source_url",
    "message": "The supplied source URL is not valid.",
    "retryable": false
  },
  "requestId": "req_xxxxxxxxx"
}
        `}</Code>
        <p>
          Catalog codes include provider timeouts, rate limits, unsupported formats, DRM-protected
          sources and output expiration.
        </p>
      </>
    ),
  },
  webhooks: {
    title: "Webhooks",
    body: (
      <>
        <p>Client webhooks include event ID, timestamp and HMAC signature headers.</p>
        <Code language="javascript">{`
const payload = eventId + "." + timestamp + "." + rawBody;
const expected = "v1=" + await hmacSha256Hex(secret, payload);
        `}</Code>
        <Code language="python">{`
import hmac, hashlib
payload = f"{event_id}.{timestamp}.{raw_body}".encode()
expected = "v1=" + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
        `}</Code>
      </>
    ),
  },
  examples: {
    title: "Examples",
    body: (
      <>
        <Code language="bash">{`
curl -X POST "$API_BASE_URL/conversions" \\
  -H "Authorization: Bearer $ELITECONVERTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: customer-request-001" \\
  --data '{"url":"https://media.example.com/input.mp4","format":"mp4","quality":"source"}'
        `}</Code>
      </>
    ),
  },
  limits: {
    title: "Limits",
    body: (
      <>
        <ul className="check-list">
          <li>Anonymous conversions require Turnstile.</li>
          <li>Source and callback URLs are limited to HTTP and HTTPS.</li>
          <li>Jobs expire according to the configured retention window.</li>
          <li>Output links may expire and should not be publicly cached.</li>
        </ul>
      </>
    ),
  },
};
