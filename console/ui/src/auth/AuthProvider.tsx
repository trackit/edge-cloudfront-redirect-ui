import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { api, setAuthTokenProvider } from "../api";
import { createSessionStore } from "./session";
import type { SessionStore } from "./session";

/**
 * Whether anyone is signed in, and the token to prove it.
 *
 * Three states, not two. Nothing is kept in browser storage, so on a fresh load
 * the answer is genuinely unknown until the API has been asked — and a guard
 * that treats "unknown" as "signed out" redirects to the login page for a moment
 * before bouncing back, which reads as a flicker at best and a redirect loop at
 * worst.
 */
export type AuthStatus = "unknown" | "signed-in" | "signed-out";

export interface AuthState {
  status: AuthStatus;
  /** Claims from the id token: who is signed in and what they may do. */
  user?: { email?: string; groups: string[] };
  /** Ends the session here and at the identity provider. */
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | undefined>(undefined);

/** Reads the payload of a JWT. Not verification — the API does that. */
const readClaims = (token: string): Record<string, unknown> => {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const userFrom = (idToken: string): AuthState["user"] => {
  const claims = readClaims(idToken);
  const groups = claims["cognito:groups"];
  return {
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    groups: Array.isArray(groups) ? groups.map(String) : [],
  };
};

/**
 * The token provider the API client reads per request.
 *
 * `force` maps to `renew` rather than `token`: the 401 retry needs a new token,
 * and `token` would hand back the rejected one while it still looks unexpired.
 */
export const tokenProviderFor =
  (store: SessionStore) =>
  (force?: boolean): Promise<string | undefined> =>
    force === true ? store.renew() : store.token();

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("unknown");
  const [user, setUser] = useState<AuthState["user"]>();
  const store = useRef<SessionStore>(undefined);

  if (store.current === undefined) {
    store.current = createSessionStore({
      refresh: async () => {
        const session = await api.auth.refresh();
        setUser(userFrom(session.idToken));
        return session;
      },
    });
    setAuthTokenProvider(tokenProviderFor(store.current));
  }

  // The bootstrap the three states exist for: ask once, on mount, and leave the
  // status `unknown` until it answers.
  useEffect(() => {
    let live = true;
    void store.current?.token().then((token) => {
      if (!live) return;
      setStatus(token === undefined ? "signed-out" : "signed-in");
    });
    return () => {
      live = false;
    };
  }, []);

  const signOut = useCallback(async () => {
    store.current?.clear();
    setStatus("signed-out");
    setUser(undefined);

    // The provider keeps its own session cookie, so clearing ours is only half
    // of it — without this, the next sign-in returns with no prompt.
    const { logoutUrl } = await api.auth.logout(
      `${window.location.origin}/login`,
    );
    window.location.assign(logoutUrl);
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
