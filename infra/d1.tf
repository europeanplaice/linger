# Apply the SQL migrations with Wrangler before deploying the Worker and Pages.
resource "cloudflare_d1_database" "auth" {
  for_each = toset(["production", "staging", "preview"])

  account_id            = var.cloudflare_account_id
  name                  = "linger-auth-${each.key}"
  primary_location_hint = "apac"
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}
