output "cloudfront_domain_name" {
  value       = aws_cloudfront_distribution.this.domain_name
  description = "The distribution's domain. Use it as the rule's pk and as the host you curl."
}

output "cloudfront_distribution_id" {
  value       = aws_cloudfront_distribution.this.id
  description = "Distribution ID (handy for `aws cloudfront get-distribution`)."
}

output "table_name" {
  value       = module.table.table_name
  description = "The DynamoDB rules table to insert rules into."
}

output "table_region" {
  value       = module.table.table_region
  description = "Region the rules table lives in (for `aws dynamodb` commands)."
}

# The edge keys rules on the viewer Host header, which for the default domain is
# the distribution's own domain — so the demo rule's pk is that domain. Rendered
# here so there is nothing to hand-edit.
output "sample_put_item_command" {
  description = "Inserts a demo redirect: /old-landing -> https://example.com/new-landing."
  value       = <<-EOT
    aws dynamodb put-item --region ${var.region} --table-name ${module.table.table_name} --item '{
      "pk": {"S": "${aws_cloudfront_distribution.this.domain_name}"},
      "sk": {"S": "REDIRECT#00100"},
      "type": {"S": "erMatchRule"},
      "statusCode": {"N": "301"},
      "redirectURL": {"S": "https://example.com/new-landing"},
      "useIncomingQueryString": {"BOOL": true},
      "matches": {"L": [{"M": {
        "matchType": {"S": "path"},
        "matchOperator": {"S": "equals"},
        "matchValue": {"S": "/old-landing"},
        "negate": {"BOOL": false},
        "caseSensitive": {"BOOL": false}
      }}]},
      "disabled": {"BOOL": false}
    }'
  EOT
}

output "test_redirect_command" {
  description = "After inserting the rule, this should return HTTP 301."
  value       = "curl -i https://${aws_cloudfront_distribution.this.domain_name}/old-landing"
}

# A rewrite is the case worth proving by hand, because it is the one that depends
# on viewer-request carrying the viewer's hostname to origin-request: the pk below
# is the distribution's domain, which the `Host` header no longer holds by the time
# rewrites are evaluated. If this rule takes effect, that mechanism works.
output "sample_rewrite_put_item_command" {
  description = "Inserts a demo rewrite: /old-pricing -> the origin's /pricing.html."
  value       = <<-EOT
    aws dynamodb put-item --region ${var.region} --table-name ${module.table.table_name} --item '{
      "pk": {"S": "${aws_cloudfront_distribution.this.domain_name}"},
      "sk": {"S": "REWRITE#00100"},
      "type": {"S": "frMatchRule"},
      "forwardSettings": {"M": {
        "pathAndQS": {"S": "/pricing.html"}
      }},
      "matches": {"L": [{"M": {
        "matchType": {"S": "path"},
        "matchOperator": {"S": "equals"},
        "matchValue": {"S": "/old-pricing"},
        "negate": {"BOOL": false},
        "caseSensitive": {"BOOL": false}
      }}]},
      "disabled": {"BOOL": false}
    }'
  EOT
}

# Repointing the same rule is what shows a rule *change* being served, rather than
# a rule existing: the path stays /old-pricing and the page it serves changes.
output "repoint_rewrite_put_item_command" {
  description = "Overwrites the demo rewrite so /old-pricing serves /plans.html instead."
  value       = <<-EOT
    aws dynamodb put-item --region ${var.region} --table-name ${module.table.table_name} --item '{
      "pk": {"S": "${aws_cloudfront_distribution.this.domain_name}"},
      "sk": {"S": "REWRITE#00100"},
      "type": {"S": "frMatchRule"},
      "forwardSettings": {"M": {
        "pathAndQS": {"S": "/plans.html"}
      }},
      "matches": {"L": [{"M": {
        "matchType": {"S": "path"},
        "matchOperator": {"S": "equals"},
        "matchValue": {"S": "/old-pricing"},
        "negate": {"BOOL": false},
        "caseSensitive": {"BOOL": false}
      }}]},
      "disabled": {"BOOL": false}
    }'
  EOT
}

output "test_rewrite_command" {
  description = "Before the rule: 404 from S3. After it: 200 and the page the rule points at."
  value       = "curl -i https://${aws_cloudfront_distribution.this.domain_name}/old-pricing"
}
