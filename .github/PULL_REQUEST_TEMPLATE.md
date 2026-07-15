## Summary

<!-- What does this PR do and why? -->

## Ticket

<!-- e.g. ER-101 -->

## Checklist

- [ ] CI is green (lint, typecheck, schemas)
- [ ] If the rule shape changed: `shared/` schemas **and** their `shared/examples/` were updated together
- [ ] If the rule shape changed and the console API exists (step 2): its OpenAPI spec `$ref`s the updated schemas — no inline redefinition
- [ ] The module still takes no input about, and creates no, `aws_cloudfront_distribution` (except under `examples/`)
