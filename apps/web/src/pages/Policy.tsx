import { usePageTitle } from "./hooks";

type PolicyType = "privacy" | "terms" | "acceptable-use";

export default function Policy({ type }: { type: PolicyType }) {
  const content = policies[type];
  usePageTitle(`${content.title} - EliteConverter`);
  return (
    <article className="page-section policy-page">
      <h1>{content.title}</h1>
      <p className="legal-note">
        This starter template requires legal review before commercial launch.
      </p>
      {content.sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <p>{section.body}</p>
        </section>
      ))}
    </article>
  );
}

const shared = {
  permission:
    "Users must own or have permission to process submitted content. DRM circumvention, access-control bypass and protected-content extraction are prohibited.",
  providers:
    "Source URLs may be processed by configured third-party providers. Upstream services and providers may affect availability, performance and output quality.",
  logs: "Sensitive tokens are redacted from logs where practical. Users remain responsible for avoiding sensitive credentials in submitted URLs.",
  availability:
    "EliteConverter does not guarantee uninterrupted availability. Output links may expire and abuse may result in blocking or revocation.",
};

const policies: Record<
  PolicyType,
  { title: string; sections: Array<{ title: string; body: string }> }
> = {
  privacy: {
    title: "Privacy Policy",
    sections: [
      { title: "Content processing", body: shared.providers },
      { title: "Logs and tokens", body: shared.logs },
      { title: "User responsibility", body: shared.permission },
      {
        title: "Retention",
        body: "Job metadata and event history are retained only as configured by the operator.",
      },
    ],
  },
  terms: {
    title: "Terms of Service",
    sections: [
      { title: "Permitted use", body: shared.permission },
      { title: "Service dependencies", body: shared.providers },
      { title: "Availability", body: shared.availability },
      {
        title: "Responsibility",
        body: "Users remain responsible for their content, source authorization and downstream use of outputs.",
      },
    ],
  },
  "acceptable-use": {
    title: "Acceptable Use Policy",
    sections: [
      { title: "Media rights", body: shared.permission },
      {
        title: "Abuse",
        body: "Credential relay, open proxy use, brute force activity, malware distribution and unauthorized scraping are prohibited.",
      },
      {
        title: "DRM and protected sources",
        body: "Widevine, FairPlay, PlayReady, paywall, authentication and CAPTCHA bypass are not supported.",
      },
      { title: "Enforcement", body: shared.availability },
    ],
  },
};
