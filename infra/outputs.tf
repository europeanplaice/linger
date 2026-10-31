output "pages_project_subdomain" {
  description = "Cloudflare Pages default subdomain"
  value       = cloudflare_pages_project.linger.subdomain
}

output "kv_sessions_id" {
  description = "KV namespace ID for production sessions (use in wrangler.toml)"
  value       = cloudflare_workers_kv_namespace.sessions.id
}

output "kv_sessions_preview_id" {
  description = "KV namespace ID for preview sessions (use in wrangler.toml)"
  value       = cloudflare_workers_kv_namespace.sessions_preview.id
}

output "kv_sessions_staging_id" {
  description = "KV namespace ID for staging sessions (use in wrangler.toml)"
  value       = cloudflare_workers_kv_namespace.sessions_staging.id
}

output "pages_project_staging_subdomain" {
  description = "Cloudflare Pages default subdomain for the staging project"
  value       = cloudflare_pages_project.linger_staging.subdomain
}
output "auth_database_ids" {
  description = "Authentication D1 IDs by environment; copy into the corresponding Pages and Worker Wrangler configs"
  value       = { for environment, database in cloudflare_d1_database.auth : environment => database.id }
}
