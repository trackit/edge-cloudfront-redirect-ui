terraform {
  # 1.7+ for mock_provider in the tftest suite.
  required_version = ">= 1.7"

  required_providers {
    # Lambda@Edge functions must live in us-east-1, so the caller passes a
    # us-east-1-configured provider as aws.use1 (see README). IAM is global and
    # rides the same alias.
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 6.0"
      configuration_aliases = [aws.use1]
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.4"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}
