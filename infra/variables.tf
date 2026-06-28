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
