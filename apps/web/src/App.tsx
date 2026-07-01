import { Suspense, lazy, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router";
import { FileText, Menu, Moon, Sun, X } from "lucide-react";
import { Button, IconButton, Logo } from "@eliteconverter/ui";
import { useTheme } from "./theme";

const Landing = lazy(() => import("./pages/Landing"));
const Convert = lazy(() => import("./pages/Convert"));
const Job = lazy(() => import("./pages/Job"));
const Docs = lazy(() => import("./pages/Docs"));
const Status = lazy(() => import("./pages/Status"));
const About = lazy(() => import("./pages/About"));
const Policy = lazy(() => import("./pages/Policy"));
const NotFound = lazy(() => import("./pages/NotFound"));

const navItems = [
  { to: "/convert", label: "Convert" },
  { to: "/docs", label: "Docs" },
  { to: "/status", label: "Status" },
  { to: "/about", label: "About" },
];

export const App = () => (
  <div className="app-shell">
    <a href="#main" className="skip-link">
      Skip to content
    </a>
    <Header />
    <main id="main" tabIndex={-1}>
      <Suspense fallback={<div className="route-loading">Loading EliteConverter...</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/convert" element={<Convert />} />
          <Route path="/jobs/:jobId" element={<Job />} />
          <Route path="/docs" element={<Docs page="overview" />} />
          <Route path="/docs/getting-started" element={<Docs page="getting-started" />} />
          <Route path="/docs/authentication" element={<Docs page="authentication" />} />
          <Route path="/docs/conversions" element={<Docs page="conversions" />} />
          <Route path="/docs/job-status" element={<Docs page="job-status" />} />
          <Route path="/docs/errors" element={<Docs page="errors" />} />
          <Route path="/docs/webhooks" element={<Docs page="webhooks" />} />
          <Route path="/docs/examples" element={<Docs page="examples" />} />
          <Route path="/docs/limits" element={<Docs page="limits" />} />
          <Route path="/status" element={<Status />} />
          <Route path="/about" element={<About />} />
          <Route path="/privacy" element={<Policy type="privacy" />} />
          <Route path="/terms" element={<Policy type="terms" />} />
          <Route path="/acceptable-use" element={<Policy type="acceptable-use" />} />
          <Route path="/404" element={<NotFound />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </main>
    <Footer />
  </div>
);

const Header = () => {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";

  return (
    <header className="site-header">
      <div className="header-inner">
        <Link to="/" className="brand-link" aria-label="EliteConverter home">
          <Logo />
        </Link>
        <nav className="desktop-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="header-actions">
          <IconButton label={`Theme: ${theme}`} onClick={() => setTheme(nextTheme)}>
            {theme === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
          </IconButton>
          <Link className="docs-button" to="/docs">
            <FileText aria-hidden="true" />
            <span>API</span>
          </Link>
          <IconButton
            label="Open navigation"
            className="mobile-menu-button"
            onClick={() => setOpen(true)}
          >
            <Menu aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      {open ? (
        <div className="mobile-nav" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="mobile-nav-panel">
            <div className="mobile-nav-head">
              <Logo compact />
              <IconButton label="Close navigation" onClick={() => setOpen(false)}>
                <X aria-hidden="true" />
              </IconButton>
            </div>
            {navItems.map((item) => (
              <NavLink key={item.to} to={item.to} onClick={() => setOpen(false)}>
                {item.label}
              </NavLink>
            ))}
            <Button onClick={() => setTheme(nextTheme)} variant="secondary">
              Theme: {theme}
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  );
};

const Footer = () => (
  <footer className="site-footer">
    <div>
      <Logo />
      <p>Created by Siddhartha Abhimanyu</p>
    </div>
    <nav aria-label="Footer navigation">
      <Link to="/privacy">Privacy</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/acceptable-use">Acceptable Use</Link>
      <a href="https://t.me/iflexsid">Telegram @iflexsid</a>
      <a href="https://instagram.com/elite.sid">Instagram elite.sid</a>
    </nav>
  </footer>
);
