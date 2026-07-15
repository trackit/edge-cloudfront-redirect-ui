# console — step 2 (placeholder)

Management API + web UI for the redirect/rewrite rules. Not started — phase 1 is the pluggable data-plane in `infra/`.

When step 2 begins: the API is designed spec-first (`openapi.yaml`), and all rule request/response bodies `$ref` the schemas in `shared/` — rule shapes are never redefined inline.
