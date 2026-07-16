terraform {
  # 1.7+ for mock_provider in the tftest suite.
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # 6.x for the per-resource `region` argument (enhanced region support).
      version = "~> 6.0"
    }
  }
}
