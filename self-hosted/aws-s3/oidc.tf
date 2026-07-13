# IAM OIDC providers are scoped to a single AWS account — even though Google is the
# same external identity provider linger's own AWS account also trusts, your account
# needs its own copy of this resource to let YOUR IAM role trust Google-issued tokens.
data "tls_certificate" "google_oidc" {
  url = "https://accounts.google.com"
}

resource "aws_iam_openid_connect_provider" "google" {
  url = "https://accounts.google.com"

  client_id_list = [var.linger_google_client_id]

  thumbprint_list = [data.tls_certificate.google_oidc.certificates[0].sha1_fingerprint]
}
