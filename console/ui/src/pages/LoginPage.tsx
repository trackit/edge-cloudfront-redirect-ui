import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import Brand from "../components/Brand";
import { authConfig, callbackUrl } from "../auth/config";
import {
  authorizeUrl,
  challengeFor,
  newPendingLogin,
  savePendingLogin,
} from "../auth/pkce";
import { useAuth } from "../auth/useAuth";

/**
 * The way in.
 *
 * A branded page of our own that hands off to Cognito's hosted UI, rather than a
 * credential form. The password, its reset, the forced first-login change,
 * lockout and MFA all stay the identity provider's problem — and adding a second
 * sign-in method later is a configuration change there rather than screens here.
 *
 * What is worth owning is this screen: the product's name, and a way back out.
 */
export default function LoginPage() {
  const { status } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // Set by the guard when it turned someone away, so a deep link survives the
  // detour through the provider.
  const returnTo =
    (location.state as { returnTo?: string } | null)?.returnTo ?? "/console";

  // Already signed in — reaching /login by typing it should not require signing
  // in again.
  if (status === "signed-in") return <Navigate to={returnTo} replace />;

  const signIn = async (): Promise<void> => {
    setPending(true);
    setError(undefined);
    try {
      const config = authConfig();
      const login = newPendingLogin(returnTo);
      savePendingLogin(login);

      window.location.assign(
        authorizeUrl({
          domain: config.domain,
          clientId: config.clientId,
          redirectUri: callbackUrl(),
          state: login.state,
          challenge: await challengeFor(login.verifier),
        }),
      );
    } catch (caught) {
      // Almost always missing build-time configuration. Saying so beats a
      // redirect to a URL that fails at the provider, where the cause is
      // invisible.
      setPending(false);
      setError(
        caught instanceof Error ? caught.message : "Could not start sign-in",
      );
    }
  };

  return (
    <div className="login">
      <nav className="nav">
        <Brand />
        <Link to="/" className="btn btn-ghost btn-sm">
          Back home
        </Link>
      </nav>

      <main className="login-main">
        <div className="login-card">
          <h1>Sign in</h1>
          <p className="sub">
            The console manages live routing rules, so it is behind your
            organisation&apos;s sign-in.
          </p>

          {error !== undefined && (
            <div className="console-error" role="alert">
              <strong>Sign-in is unavailable</strong>
              <span>{error}</span>
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => void signIn()}
            disabled={pending}
          >
            {pending ? "Redirecting…" : "Continue to sign in"}
          </button>
        </div>
      </main>
    </div>
  );
}
