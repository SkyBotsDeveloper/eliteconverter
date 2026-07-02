import { ConversionForm } from "../components/ConversionForm";
import { usePageTitle } from "./hooks";

export default function Convert() {
  usePageTitle("Convert - EliteConverter");
  return (
    <section className="page-section convert-page">
      <div className="section-head">
        <h1>Convert</h1>
        <p>Submit an authorized, provider-supported media URL and track the asynchronous job.</p>
      </div>
      <ConversionForm />
    </section>
  );
}
