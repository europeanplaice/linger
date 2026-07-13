# Bring your own S3 bucket for linger

Advanced option: connect linger to an S3 bucket in your own AWS account instead
of (or alongside) linger's default storage. Requires an AWS account and basic
familiarity with Terraform and IAM — this is not exposed as a one-click option
because AWS, unlike Google, has no consumer-facing OAuth consent screen that
lets an app request access to "your" S3 bucket. You set up the trust
relationship yourself, once, in your own account.

## What this does

Creates, in **your own AWS account**:

- An IAM OIDC identity provider trusting Google (`accounts.google.com`)
- An IAM role that only *your* linger session can assume — scoped to both
  linger's OAuth client ID (`aud`) and your personal Google account ID
  (`sub`), so no other linger user can use it even though they share the same
  `aud`
- An S3 bucket (versioned, encrypted, fully private) that role can read/write

linger never receives long-lived AWS credentials for this bucket — it
exchanges your existing Google sign-in token for short-lived AWS credentials
at request time via `sts:AssumeRoleWithWebIdentity`.

## Prerequisites

- An AWS account, and credentials for it available to Terraform (`AWS_PROFILE`,
  or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or SSO)
- [Terraform](https://developer.hashicorp.com/terraform) >= 1.5
- linger's current Google OAuth client ID (`linger_google_client_id`) — from
  linger's Settings, or from the operator
- Your own Google account's `sub` claim (`linger_google_sub`) — a stable
  numeric ID, not your email

## Steps

1. Copy the example vars and fill them in:

   ```bash
   cp terraform.tfvars.example terraform.tfvars
   $EDITOR terraform.tfvars
   ```

2. Apply:

   ```bash
   terraform init
   terraform apply
   ```

3. Copy the `role_arn` output and paste it into linger's Settings under your
   S3 connection.

## Rotating access

If you ever want to revoke linger's access, delete the IAM role
(`terraform destroy`, or just delete `aws_iam_role.linger_s3` in the AWS
console) — linger immediately loses the ability to assume it. Your bucket and
its contents are untouched.

## Notes

- If linger rotates its Google OAuth client (a blue/green swap on linger's
  side), `linger_google_client_id` here goes stale and this role stops
  trusting linger until you update the variable and re-apply.
- The bucket has versioning enabled and is fully private (no public access,
  no bucket policy needed) — only the IAM role created here can reach it.
