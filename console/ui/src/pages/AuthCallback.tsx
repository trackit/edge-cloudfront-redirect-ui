import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Brand from "../components/Brand";
import { api } from "../api";
import { callbackUrl } from "../auth/config";
import { takePendingLogin } from "../auth/pkce";

/**
 * Where the provider sends the browser back to.
 *
 * Exchanges the authorization code for a session and then leaves. Nothing is
 * rendered on the happy path beyond a moment of "signing you in" — this is a
 * step in a redirect, not a page anyone should arrive at deliberately.
 */
export default function AuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  // Strict Mode mounts effects twice in development, and an authorization code
  // is single-use: the second exchange would fail and show an error over a login
  // that worked.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const pending = takePendingLogin();
    const code = params.get("code");
    const state = params.get("state");
    const denied = params.get("error");

    const run = async (): Promise<void> => {
      if (denied !== null) {
        // The provider refused, usually because the user cancelled.
        setError("Sign-in was cancelled.");
        return;
      }
      if (pending === undefined || code === null || state === null) {
        // No round trip in progress — a bookmarked callback URL, or a reload
        // after the pending login was consumed.
        setError("That sign-in link is no longer valid. Start again.");
        return;
      }
      if (state !== pending.state) {
        // The CSRF guard: a code that arrived without the state this tab issued
        // was not requested here.
        setError("That sign-in did not come from this browser.");
        return;
      }

      try {
        await api.auth.session({
          code,
          redirectUri: callbackUrl(),
          codeVerifier: pending.verifier,
        });
        // Replace, so Back does not return to a callback URL whose code is spent.
        navigate(pending.returnTo, { replace: true });
      } catch {
        setError("That sign-in could not be completed. Please try again.");
      }
    };

    void run();
  }, [params, navigate]);

  return (
    <div className="login">
      <nav className="nav">
        <Brand />
      </nav>
      <main className="login-main">
        <div className="login-card">
          {error === undefined ? (
            <p role="status" aria-live="polite">
              Signing you in…
            </p>
          ) : (
            <>
              <div className="console-error" role="alert">
                <strong>Sign-in failed</strong>
                <span>{error}</span>
              </div>
              <Link to="/login" className="btn btn-primary btn-block">
                Back to sign in
              </Link>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
