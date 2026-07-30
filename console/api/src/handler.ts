import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { ApiRequest, ApiResponse } from "./context.js";
import { ApiError } from "./lib/errors.js";
import { createRouter } from "./router.js";
import { routes } from "./routes.js";

const router = createRouter(routes);

const stringRecord = (
  input: Record<string, string | undefined> | undefined,
  lowercaseKeys = false,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value !== undefined)
      out[lowercaseKeys ? key.toLowerCase() : key] = value;
  }
  return out;
};

const parseBody = (event: APIGatewayProxyEventV2): unknown => {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
};

const toApiRequest = (event: APIGatewayProxyEventV2): ApiRequest => ({
  method: event.requestContext.http.method,
  path: event.rawPath,
  params: {},
  query: stringRecord(event.queryStringParameters),
  headers: stringRecord(event.headers, true),
  body: parseBody(event),
});

const serialize = (res: ApiResponse): APIGatewayProxyStructuredResultV2 => ({
  statusCode: res.status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(res.body),
});

/** Lambda entry point for the console API. */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    return serialize(await router.handle(toApiRequest(event)));
  } catch (err) {
    if (err instanceof ApiError) return serialize(err.toResponse());
    console.error("console-api: unhandled error", err);
    return serialize(
      new ApiError(500, "INTERNAL", "Internal server error").toResponse(),
    );
  }
};
