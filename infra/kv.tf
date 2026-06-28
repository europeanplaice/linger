# Existing KV namespace IDs (wrangler.toml):
#   production : c97ec063171444f7929955e3d8247211
#   preview    : ea13bcd4fd2f4bdcba8cbbfddf7ac4f2
#
# Import commands (run once to pull existing state):
#   terraform import cloudflare_workers_kv_namespace.sessions \
#     <ACCOUNT_ID>/c97ec063171444f7929955e3d8247211
#   terraform import cloudflare_workers_kv_namespace.sessions_preview \
#     <ACCOUNT_ID>/ea13bcd4fd2f4bdcba8cbbfddf7ac4f2

resource "cloudflare_workers_kv_namespace" "sessions" {
  account_id = var.cloudflare_account_id
  title      = "linger-sessions"
}

resource "cloudflare_workers_kv_namespace" "sessions_preview" {
  account_id = var.cloudflare_account_id
  title      = "linger-sessions-preview"
}
