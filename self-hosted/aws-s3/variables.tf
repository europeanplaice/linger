variable "aws_region" {
  description = "AWS region for your S3 bucket and IAM role"
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "Name of the S3 bucket linger will store your diary data in. Must be globally unique across all of AWS."
  type        = string
}

variable "linger_google_client_id" {
  description = "linger's Google OAuth client ID (the OIDC 'aud' value). Find it in linger's Settings, or ask the linger operator — this is not secret, but changes rarely."
  type        = string
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
}
