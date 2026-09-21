# console — control plane (step 2)

Management API + web UI for the redirect/rewrite rules. This is a client of the
data-plane's DynamoDB table; it never talks to the Lambda@Edge directly.

| Package       | What                                               | Status      |
| ------------- | -------------------------------------------------- | ----------- |
| [`api/`](api) | Serverless API — HTTP API Gateway + Lambda (CF-11) | scaffolded  |
| `ui/`         | React/Vite SPA                                     | implemented |

The API is designed spec-first (`api/openapi.yaml`), and all rule
request/response bodies `$ref` the schemas in [`../shared`](../shared) — rule
shapes are never redefined inline.
