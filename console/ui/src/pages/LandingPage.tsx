import { Link } from 'react-router-dom';
import Brand from '../components/Brand';
import { IconArrow } from '../components/icons';

export default function LandingPage() {
  return (
    <div className="landing">
      {/* minimal nav — single way into the console */}
      <nav className="nav">
        <Brand />
        <Link to="/login" className="btn btn-dark btn-sm">
          Open console
        </Link>
      </nav>

      {/* hero — one message, one call to action */}
      <header className="hero">
        <h1>
          Manage CloudFront redirects
          <br />
          <span className="grad">without touching code</span>
        </h1>
        <p className="sub">
          A simple console to add and edit redirect &amp; rewrite rules on your
          CloudFront distribution — no pull request, no redeploy.
        </p>
        <div className="hero-cta">
          <Link to="/login" className="btn btn-primary btn-lg">
            Open the console <IconArrow size={18} />
          </Link>
        </div>
        <p className="hero-note">Prototype · runs on mock data</p>
      </header>

      {/* plain-language explainer: the two kinds of rules */}
      <section className="section" style={{ paddingTop: 20 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 18,
            maxWidth: 760,
            margin: '0 auto',
          }}
        >
          <article className="feature">
            <div
              className="ico"
              style={{ color: 'var(--orange)', fontSize: 22 }}
            >
              ↪
            </div>
            <h3>Redirect</h3>
            <p>
              Send visitors from an old URL to a new one (a 301 or 302). The
              address in their browser changes — like <span className="mono">
                /old-page
              </span>{' '}
              → <span className="mono">/new-page</span>.
            </p>
          </article>
          <article className="feature">
            <div className="ico" style={{ color: 'var(--blue)', fontSize: 22 }}>
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

      <footer className="footer">
        <div className="footer-inner">
          <span>EdgeRoute · prototype</span>
          <span>Not connected to a live backend</span>
        </div>
      </footer>
    </div>
  );
}
