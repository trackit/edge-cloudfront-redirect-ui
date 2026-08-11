import type { ApiRequest, ApiResponse, Handler } from "./context.js";
import { ApiError } from "./lib/errors.js";
import { hostKey } from "./lib/validate-host.js";

export interface Route {
  method: string;
  /** Path pattern with `:name` params, e.g. `/targets/:targetId/hosts/:host/rules`. */
  pattern: string;
  handler: Handler;
}

interface CompiledRoute {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

const normalize = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
};

/**
 * Path params that are normalized as they are bound, by name.
 *
 * Only `host`, and only because it is a DynamoDB partition key: `/hosts/WWW.Example.com/rules`
 * and `/hosts/www.example.com/rules` name one host in DNS but two partitions in
 * the table. Doing it here rather than in each handler is deliberate — this is
 * the one place every route's params pass through, so a route added later cannot
 * quietly reintroduce the split. `targetId` and `sk` are opaque server-generated
 * strings and are left exactly as sent.
 */
const NORMALIZE_PARAM: Record<string, (value: string) => string> = {
  host: hostKey,
};

const decodeParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    // A lone `%` or other bad escape — a client error, not a 500.
    throw new ApiError(400, "BAD_REQUEST", "Malformed path parameter");
  }
};

// Patterns are our own literals plus `:name` params; params become a single
// path segment. No user input reaches the pattern, so segment literals are not
// regex-escaped here.
const compile = (route: Route): CompiledRoute => {
  const keys: string[] = [];
  const body = normalize(route.pattern).replace(/:[A-Za-z0-9_]+/g, (match) => {
    keys.push(match.slice(1));
    return "([^/]+)";
  });
  return {
    method: route.method.toUpperCase(),
    regex: new RegExp(`^${body}$`),
    keys,
    handler: route.handler,
  };
};

export interface Router {
  handle(req: ApiRequest): Promise<ApiResponse>;
}

export const createRouter = (routes: Route[]): Router => {
  const compiled = routes.map(compile);

  return {
    async handle(req: ApiRequest): Promise<ApiResponse> {
      const path = normalize(req.path);
      const method = req.method.toUpperCase();
      let pathMatched = false;

      for (const route of compiled) {
        const match = route.regex.exec(path);
        if (!match) continue;
        if (route.method !== method) {
          pathMatched = true;
          continue;
        }

        const params: Record<string, string> = {};
        route.keys.forEach((key, i) => {
          const value = match[i + 1];
          if (value === undefined) return;

          // Decode first: the normalizer works on the real value, not on its
          // percent-encoded spelling.
          const decoded = decodeParam(value);
          params[key] = NORMALIZE_PARAM[key]?.(decoded) ?? decoded;
        });

        return route.handler({ ...req, params });
      }

      if (pathMatched) {
        throw ApiError.methodNotAllowed(
          `${req.method} ${req.path} is not allowed`,
        );
      }
      throw ApiError.notFound(`${req.method} ${req.path} not found`);
    },
  };
};
