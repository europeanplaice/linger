resource "cloudflare_dns_record" "linger" {
  zone_id = var.cloudflare_zone_id
  name    = "linger"
  content = cloudflare_pages_project.linger.subdomain
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

resource "cloudflare_dns_record" "linger_staging" {
  zone_id = var.cloudflare_zone_id
  name    = "staging.linger"
  content = cloudflare_pages_project.linger_staging.subdomain
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

moved {
  from = cloudflare_record.linger
  to   = cloudflare_dns_record.linger
}

moved {
  from = cloudflare_record.linger_staging
  to   = cloudflare_dns_record.linger_staging
}
