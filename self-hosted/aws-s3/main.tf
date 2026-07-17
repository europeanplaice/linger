terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5"
    }
  }
}

# Credentials come from your environment (AWS_PROFILE / AWS_ACCESS_KEY_ID+SECRET /
# SSO) — this is your own AWS account, separate from linger's.
provider "aws" {
  region = var.aws_region
}
