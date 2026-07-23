import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

/**
 * Lambda entry point for the console API.
 *
 * Scaffold only: the router, validation and error plumbing land in the next
 * step of ER-201. For now every request returns a standardized 501 so the
 * workspace builds and deploys as a live-but-empty API.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  return {
    statusCode: 501,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      error: {
        code: "NOT_IMPLEMENTED",
        message: `${method} ${path} is not implemented yet`,
      },
    }),
  };
};
