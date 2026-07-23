import { createServer } from "node:http";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "./handler.js";

/**
 * Local dev server — `npm run dev -w console/api`.
 *
 * Scaffold only: it maps just the method and path so the handler can boot over
 * HTTP without SAM. The full event adapter (headers, query string, body) lands
 * with the router in the next step of ER-201.
 */
const port = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => {
  const event = {
    rawPath: req.url ?? "/",
    requestContext: { http: { method: req.method ?? "GET" } },
  } as APIGatewayProxyEventV2;

  handler(event)
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
