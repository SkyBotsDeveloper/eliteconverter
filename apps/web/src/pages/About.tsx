import { Camera, Send, ShieldCheck } from "lucide-react";
import { Logo, Panel } from "@eliteconverter/ui";
import { usePageTitle } from "./hooks";

export default function About() {
  usePageTitle("About - EliteConverter");
  return (
    <section className="page-section">
      <div className="about-hero">
        <Logo />
        <h1>About EliteConverter</h1>
        <p>
          EliteConverter is a provider-backed conversion gateway for authorized media workflows. It
          is designed for secure validation, asynchronous processing and developer integration.
        </p>
      </div>
      <div className="workflow-section">
        <Panel>
          <ShieldCheck aria-hidden="true" className="panel-icon" />
          <h2>Responsible use</h2>
          <p>
            Only convert media that you own or have permission to process. DRM bypass is prohibited.
          </p>
        </Panel>
        <Panel>
          <h2>Credits</h2>
          <p>Created by Siddhartha Abhimanyu</p>
          <p className="contact-row">
            <Send aria-hidden="true" /> <a href="https://t.me/iflexsid">Telegram @iflexsid</a>
          </p>
          <p className="contact-row">
            <Camera aria-hidden="true" />{" "}
            <a href="https://instagram.com/elite.sid">Instagram elite.sid</a>
          </p>
        </Panel>
      </div>
    </section>
  );
}
