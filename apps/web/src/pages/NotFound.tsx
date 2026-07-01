import { Link } from "react-router";
import { usePageTitle } from "./hooks";

export default function NotFound() {
  usePageTitle("Not Found - EliteConverter");
  return (
    <section className="page-section not-found-page">
      <h1>404</h1>
      <p>The requested page was not found.</p>
      <Link className="primary-link" to="/">
        Return home
      </Link>
    </section>
  );
}
