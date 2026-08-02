variable "cloudflare_api_token" {
  description = "Cloudflare API token (Pages:Edit, Workers KV Storage:Edit, Zone DNS:Edit). If reused as the CI CLOUDFLARE_API_TOKEN secret, also needs Workers Scripts:Edit — CI deploys the s3-workflows Worker via `wrangler deploy`, not Terraform."
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

variable "s3_workflows_worker_prefix" {
  description = "Prefix used for the S3 Workflows Worker names (the Workers themselves deploy via `wrangler deploy`, not Terraform — this only feeds the Pages S3_WORKFLOW_SERVICE binding, which references them by name)"
  type        = string
  default     = "linger-s3-workflows"
}
