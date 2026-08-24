import { useContext } from "react";
import { AuthContext } from "./AuthProvider";
import type { AuthState } from "./AuthProvider";

/**
 * The current session.
 *
 * Throws outside the provider rather than returning a signed-out default: a
 * component rendered outside it would silently behave as though nobody is
 * signed in, which looks like a session bug rather than a wiring mistake.
 */
export const useAuth = (): AuthState => {
  const state = useContext(AuthContext);
  if (state === undefined) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return state;
};

/** Whether the signed-in user may change anything. Mirrors the API's own rule. */
export const useCanWrite = (): boolean =>
  useAuth().user?.groups.includes("editor") === true;
