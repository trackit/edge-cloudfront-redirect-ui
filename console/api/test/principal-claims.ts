/**
 * JWT claims as the gateway's authorizer hands them to the Lambda.
 *
 * The suites below test what the API does for someone allowed to do it, so they
 * authenticate as an editor. That is a fixture, not the subject: which roles may
 * reach which routes is `router.test.ts`'s job, and turning an event into a
 * principal is `principal.test.ts`'s.
 *
 * These carry no `Authorization` header, so they exercise the fallback path —
 * claims read from the authorizer context. The header path, which is what
 * production takes, is covered in `principal.test.ts` and `handler.test.ts`.
 */
export const claims = (groups: string[], sub = "user-1") => ({
  authorizer: {
    jwt: {
      claims: {
        sub,
        email: `${groups[0] ?? "nobody"}@example.com`,
        // A real array here; API Gateway also delivers this claim as the string
        // "[editor]", which `parseGroups` reads and `principal.test.ts` covers.
        "cognito:groups": groups,
      },
    },
  },
});

export const EDITOR = claims(["editor"]);
export const VIEWER = claims(["viewer"]);
