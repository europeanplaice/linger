variable "aws_region" {
  description = "AWS region for your S3 bucket and IAM role"
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "Name of the S3 bucket linger will store your diary data in. Must be globally unique across all of AWS."
  type        = string
}

variable "noncurrent_version_expiration_days" {
  description = "Days to keep a past version of a diary entry (or a deleted entry's delete marker) before S3 permanently expires it. Bucket versioning otherwise retains every past revision forever."
  type        = number
  default     = 90
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
    every linger user. Find your sub via linger's Settings (once exposed there), or by
    decoding your own id_token.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.linger_google_sub))
    error_message = "linger_google_sub must be your Google account's numeric 'sub' claim (digits only) — not your email address, and not the terraform.tfvars.example placeholder."
  }
}
