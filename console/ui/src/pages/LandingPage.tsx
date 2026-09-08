import { Link } from "react-router-dom";
import Brand from "../components/Brand";
import ProfileMenu from "../components/ProfileMenu";
import { IconArrow } from "../components/icons";
import { useAuth } from "../auth/useAuth";

/* Ticket: MVP - Front — Home page. Public landing page: what EdgeRoute is,
   the way into the console, and the two rule kinds explained in plain language. */
export default function LandingPage() {
  const { status } = useAuth();

  return (
    <div className="landing">
      {/* minimal nav — single way into the console */}
      <nav className="nav">
        <Brand />
        {/* The page is public, so this is the one place in the app that has to
            render for both a visitor and a signed-in user. Nothing is shown
            while the session is still unknown: a "Sign in" that turns into a
            profile a moment later is worse than a beat of nothing. */}
        <div className="nav-end">
          <Link to="/console" className="btn btn-dark btn-sm">
            Open console
          </Link>
          {status === "signed-in" && <ProfileMenu />}
        </div>
      </nav>

      {/* Takes the height between nav and footer so the hero and tiles sit
          centred in it when the page is short enough not to scroll. */}
      <main className="landing-main">
        {/* hero — one message, one call to action */}
        <header className="hero">
          <h1>
            Manage CloudFront redirects
            <br />
            <span className="grad">without touching code</span>
          </h1>
          <p className="sub">
            A simple console to add and edit redirect &amp; rewrite rules on
            your CloudFront distribution — no pull request, no redeploy.
          </p>
          <div className="hero-cta">
            <Link to="/console" className="btn btn-primary btn-lg">
              Open the console <IconArrow size={18} />
            </Link>
          </div>
        </header>

        {/* plain-language explainer: the two kinds of rules */}
        <section className="section">
          <div className="feature-grid">
            <article className="feature">
              <div className="ico" style={{ color: "var(--orange)" }}>
                ↪
              </div>
              <h3>Redirect</h3>
              <p>
                Send visitors from an old URL to a new one (a 301 or 302). The
                address in their browser changes — like{" "}
                <span className="mono">/old-page</span> →{" "}
                <span className="mono">/new-page</span>.
              </p>
            </article>
            <article className="feature">
              <div className="ico" style={{ color: "var(--blue)" }}>
                ⇄
              </div>
              <h3>Rewrite</h3>
              <p>
                Quietly fetch content from a different origin (an S3 bucket or
                another backend). The visitor sees the same URL — only where the
                content comes from changes.
              </p>
            </article>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span>EdgeRoute</span>
        </div>
      </footer>
    </div>
  );
}
