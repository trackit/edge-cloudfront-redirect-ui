# Default provider: the table, the demo distribution, and the placeholder S3
# origin. CloudFront is global, so any region works for these.
provider "aws" {
  region = var.region

  default_tags {
    tags = var.tags
  }
}

# Lambda@Edge functions must live in us-east-1. The edge module takes this as
# aws.use1 regardless of where the rest of the stack is deployed.
provider "aws" {
  alias  = "use1"
  region = "us-east-1"

  default_tags {
    tags = var.tags
  }
}
