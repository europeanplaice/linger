variable "cloudflare_api_token" {
  description = "Cloudflare API token (Pages:Edit, Workers KV Storage:Edit)"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}
