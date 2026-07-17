variable "aws_region" {
  description = "AWS region for your S3 bucket and IAM role"
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "Name of the S3 bucket linger will store your diary data in. Must be globally unique across all of AWS — try appending your AWS account ID or a random suffix, e.g. \"linger-diary-123456789012\"."
  type        = string

  validation {
    condition     = var.bucket_name != "CHANGE-ME-linger-diary-<your-aws-account-id-or-random-suffix>"
    error_message = "bucket_name must be a name you chose yourself, not the terraform.tfvars.example placeholder — S3 bucket names are globally unique across all of AWS, so a generic placeholder like \"my-linger-diary\" will almost always already be taken. Try appending your AWS account ID or a random suffix, e.g. \"linger-diary-123456789012\"."
  }
}

variable "linger_google_client_id" {
  description = "linger's Google OAuth client ID (the OIDC 'aud' value). Find it in linger's Settings, or ask the linger operator — this is not secret, but changes rarely."
  type        = string

  validation {
    condition     = can(regex("\\.apps\\.googleusercontent\\.com$", var.linger_google_client_id))
    error_message = "linger_google_client_id must end in .apps.googleusercontent.com — this is linger's own Google OAuth client ID (the 'aud' value), not something you create yourself."
  }
}

variable "additional_google_oidc_client_ids" {
  description = <<-EOT
    Other OAuth client IDs (the 'aud' values other tools/apps use) that already trust
    this AWS account's https://accounts.google.com OIDC provider, if you imported an
    existing one (see the README's troubleshooting section). client_id_list is
    reconciled against AWS's actual state on every apply, so any client ID missing
    from this list — including ones this Terraform config didn't create — is removed
    from the provider. Leave empty if you're creating a brand-new OIDC provider.
  EOT
  type        = list(string)
  default     = []
}

variable "linger_google_sub" {
  description = <<-EOT
    Your own Google account's stable numeric ID (the OIDC 'sub' claim), NOT your email.
    This is what restricts the IAM role to only your linger session — without it, any
    signed-in linger user could assume this role, since 'aud' alone is the same for
    every linger user. This is the same value shown as "Your Google account ID" in
    linger's Settings under S3 backup (advanced) — copy it from there, or decode it
    yourself from your own id_token.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.linger_google_sub))
    error_message = "linger_google_sub must be your Google account's numeric 'sub' claim (digits only) — not your email address, and not the terraform.tfvars.example placeholder."
  }
}
