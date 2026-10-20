terraform {
  # 1.7+ for mock_provider in the tftest suite.
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Capped below 6.69.0 like console/api/infra, so every deployed stack
      # runs the same provider: 6.69.0 cannot upload a Lambda zip over ~48 KB.
      version = ">= 6.0, < 6.69.0"
    }
    # Zips the echo origin's handler.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
