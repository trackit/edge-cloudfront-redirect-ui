import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

/**
 * Keeps a route behind a session.
 *
 * The `unknown` case is the one that matters. Nothing is kept in browser
 * storage, so on a fresh load the app does not yet know whether anyone is signed
 * in — and redirecting during that gap sends a signed-in user to the login page,
 * which then sends them back, which is the flicker-or-loop this whole three-state
 * arrangement exists to prevent. So it renders nothing until the answer arrives.
 *
 * This is a convenience, not a control: the API refuses an unauthenticated
 * request whatever the browser chooses to render.
 */
export default function RequireAuth({
  children,
}: {
  children: React.ReactNode;
}) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "unknown") {
    return (
      <div className="auth-pending" role="status" aria-live="polite">
        <span className="sr-only">Checking your session…</span>
      </div>
    );
  }

  if (status === "signed-out") {
    // The current URL is carried through so a deep link survives the detour —
    // signing in from /console/hosts/x should land back on that host.
    return (
      <Navigate
        to="/login"
        replace
        state={{ returnTo: location.pathname + location.search }}
      />
    );
  }

  return <>{children}</>;
}
