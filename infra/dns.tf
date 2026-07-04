resource "cloudflare_record" "linger" {
  zone_id         = var.cloudflare_zone_id
  name            = "linger"
  content         = cloudflare_pages_project.linger.subdomain
  type            = "CNAME"
  proxied         = true
  allow_overwrite = true
}

resource "cloudflare_record" "linger_staging" {
  zone_id         = var.cloudflare_zone_id
  name            = "staging.linger"
  content         = cloudflare_pages_project.linger_staging.subdomain
  type            = "CNAME"
  proxied         = true
  allow_overwrite = true
}
