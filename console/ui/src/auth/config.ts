/**
 * Where the hosted UI lives, and which app client to present as.
 *
 * Baked at build time like `VITE_API_BASE_URL`, because the deployment that
 * builds the SPA is the same Terraform apply that creates the pool — a recreated
 * pool reuploads the bundle anyway, so reading these at runtime would add a
 * request without removing a rebuild.
 *
 * Neither value is a secret. The client id is in every authorize URL and the
 * domain is where the browser is sent; the secret they pair with never leaves
 * the API.
 */
export interface AuthConfig {
  domain: string;
  clientId: string;
}

export const authConfig = (): AuthConfig => {
  const domain = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;
  const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;

  if (!domain || !clientId) {
    // Thrown rather than defaulted: a placeholder would send the browser to a
    // URL that fails at Cognito, where the cause is invisible. Failing here says
    // which variable is missing.
    throw new Error(
      "Sign-in is not configured: VITE_COGNITO_DOMAIN and VITE_COGNITO_CLIENT_ID must be set at build time (see console/api/infra outputs)",
    );
  }

  return { domain: domain.replace(/\/+$/, ""), clientId };
};

/** Where Cognito sends the browser back to. Absolute, as the spec requires. */
export const callbackUrl = (): string =>
  `${window.location.origin}/auth/callback`;

/** Where Cognito sends the browser after clearing its own session. */
export const postLogoutUrl = (): string => `${window.location.origin}/login`;
