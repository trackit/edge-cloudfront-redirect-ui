import { createServer, type IncomingMessage } from "node:http";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "./handler.js";

/**
 * Local dev server — `npm run dev -w console/api`.
 *
 * Adapts a node HTTP request into the API Gateway v2 event and runs the same
 * `handler`, so local and deployed share one code path (no SAM).
 */
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const toEvent = (
  req: IncomingMessage,
  body: string,
): APIGatewayProxyEventV2 => {
  // Concatenated, not resolved against a base: a request target starting with
  // `//` is protocol-relative to the URL parser, so `new URL(target, base)`
  // would read the first segment as a hostname and drop it from the path. API
  // Gateway passes the raw target through as `rawPath`, and local has to match
  // it or the dev server serves routes the deployed API would 404.
  const url = new URL(`http://localhost${req.url ?? "/"}`);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => (query[key] = value));
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
  }

  // Only the fields the handler reads; the rest of the event is not needed locally.
  return {
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    queryStringParameters: query,
    body: body || undefined,
    isBase64Encoded: false,
    requestContext: { http: { method: req.method ?? "GET" } },
  } as APIGatewayProxyEventV2;
};

const port = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => {
  readBody(req)
    .then((body) => handler(toEvent(req, body)))
    .then((result) => {
      res.writeHead(result.statusCode ?? 200, {
        "content-type": "application/json",
      });
      res.end(result.body ?? "");
    })
    .catch((err: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "INTERNAL",
            message: err instanceof Error ? err.message : String(err),
          },
        }),
      );
    });
});

server.listen(port, () => {
  console.log(`console-api dev server listening on http://localhost:${port}`);
});
