resource "cloudflare_record" "linger" {
  zone_id         = var.cloudflare_zone_id
  name            = "linger"
  content         = cloudflare_pages_project.linger.subdomain
  type            = "CNAME"
  proxied         = true
  allow_overwrite = true
}

resource "cloudflare_record" "grasspuffer" {
  zone_id         = var.cloudflare_zone_id
  name            = "grasspuffer"
  content         = cloudflare_pages_project.linger.subdomain
  type            = "CNAME"
  proxied         = true
  allow_overwrite = true
}
