terraform {
  # 1.7+ for mock_provider in the tftest suite.
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # 6.69.0 fails to upload a Lambda zip whose base64 body passes 64 KB
      # (~48 KB zipped), before anything is sent: "decomposing request:
      # bufio.Scanner: token too long". 6.68.0 uploads it. The console API's zip
      # is well over; lift the cap once a release uploads it again.
      version = ">= 6.0, < 6.69.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}
