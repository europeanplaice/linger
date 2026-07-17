# IAM OIDC providers are scoped to a single AWS account — even though Google is the
# same external identity provider linger's own AWS account also trusts, your account
# needs its own copy of this resource to let YOUR IAM role trust Google-issued tokens.
#
# No thumbprint_list: for well-known IdPs like Google, AWS verifies the IdP's server
# certificate against its own library of trusted root CAs and ignores any configured
# thumbprint, so there's nothing to compute or keep in sync here.
resource "aws_iam_openid_connect_provider" "google" {
  url = "https://accounts.google.com"

  client_id_list = [var.linger_google_client_id]
}
