variable "cloudflare_api_token" {
  description = "Cloudflare API token (Pages:Edit, Workers KV Storage:Edit, Zone DNS:Edit)"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for europeanplaice.com"
  type        = string
}

variable "s3_workflows_bundle_path" {
  description = "Path to the bundled S3 Workflows Worker, relative to the Terraform root"
  type        = string
  default     = "../artifacts/s3-workflows/index.js"
}

variable "s3_workflows_worker_prefix" {
  description = "Prefix used for the S3 Workflows Worker names"
  type        = string
  default     = "linger-s3-workflows"
}

variable "s3_workflow_name" {
  description = "Workflow name registered on each S3 Workflows Worker"
  type        = string
  default     = "s3-backfill-workflow"
}
