# Import commands (run once to pull existing state):
#   terraform import cloudflare_pages_project.linger \
#     <ACCOUNT_ID>/linger
#   terraform import cloudflare_pages_domain.linger \
#     <ACCOUNT_ID>/linger/linger.europeanplaice.com

resource "cloudflare_pages_project" "linger" {
  account_id        = var.cloudflare_account_id
  name              = "linger"
  production_branch = "main"

  build_config {
    build_command   = "npm run build"
    destination_dir = "dist"
  }

  deployment_configs {
    production {
      compatibility_date = "2024-11-01"
      kv_namespaces = {
        SESSIONS = cloudflare_workers_kv_namespace.sessions.id
      }
      # Secrets are managed outside Terraform (wrangler pages secret put):
      #   GOOGLE_CLIENT_ID
      #   GOOGLE_CLIENT_SECRET
      #   SESSION_DOMAIN
    }
    preview {
      compatibility_date = "2024-11-01"
      kv_namespaces = {
        SESSIONS = cloudflare_workers_kv_namespace.sessions_preview.id
      }
    }
  }
}

resource "cloudflare_pages_domain" "linger" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.linger.name
  domain       = "linger.europeanplaice.com"
}
