# Bring your own S3 bucket for linger

Advanced option: back up linger diary entries to an S3 bucket in your own AWS
account. Google Drive remains the primary store; S3 does not replace it. The
backup covers diary entries, not milestones or other app settings. It requires
an AWS account and basic
familiarity with Terraform and IAM — this is not exposed as a one-click option
because AWS, unlike Google, has no consumer-facing OAuth consent screen that
lets an app request access to "your" S3 bucket. You set up the trust
relationship yourself, once, in your own account.

## What this does

Creates, in **your own AWS account**:

- An IAM OIDC identity provider trusting Google (`accounts.google.com`)
- An IAM role whose trust policy checks both linger's OAuth client ID (`aud`)
  and your Google account ID (`sub`). Other users of the same linger client
  cannot assume it using their own Google identities.
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
  numeric ID, not your email. Shown as "Your Google account ID" in linger's
  Settings under S3 backup (advanced)

## Steps

1. Obtain this repository and work in its `self-hosted/aws-s3` directory.
   In linger's S3 settings, enter a globally unique bucket name and AWS region,
   then download `terraform.tfvars` into this directory. Check the values,
   including your Google account ID and linger's client ID. Alternatively, copy
   and edit the example file:

   ```bash
   cp terraform.tfvars.example terraform.tfvars
   $EDITOR terraform.tfvars
   ```

2. Apply:

   ```bash
   terraform init
   terraform apply
   ```

3. Paste the `role_arn` output into linger's S3 settings. Enter the `bucket_name`
   output and the region used in `terraform.tfvars`, then use "Test connection".
   Enable backup and save the settings. Keep linger open and authorized while
   existing entries are being backed up; closing or reloading pauses that work.

## Rotating access

To stop future role assumptions, remove the IAM role using an appropriate AWS
or Terraform change. Already-issued temporary credentials may remain usable until
they expire; use AWS role-session revocation or permissions controls if immediate
revocation is needed. Turning backup off does not delete bucket contents.
The bucket has `prevent_destroy`, so `terraform destroy` will refuse to destroy
this configuration while that protection remains in place.

## Notes

- If linger rotates its Google OAuth client (a blue/green swap on linger's
  side), `linger_google_client_id` here goes stale and this role stops
  trusting linger until you update the variable and re-apply.
- The bucket has versioning and public-access blocking enabled. The created IAM
  role has access; other principals in your AWS account may also have access
  depending on their permissions and account policies.
- Past versions of an entry (including deleted entries, which are just a
  delete marker on top of the version stack) are kept forever — nothing here
  ever expires them automatically. If you want to permanently purge old
  versions (e.g. after deleting an entry for privacy reasons), do it
  yourself: `aws s3api list-object-versions --bucket <bucket>` to find the
  version IDs, then `aws s3api delete-object --bucket <bucket> --key <key>
  --version-id <id>` for each one you want gone. This is irreversible.
- The bucket has `prevent_destroy` set, so `terraform destroy` (or removing
  it from your config) will refuse to delete it and everything in it. To
  actually remove the bucket, delete the `lifecycle` block in `s3.tf` first,
  then destroy/empty it deliberately.

## Troubleshooting

**`terraform apply` fails with `EntityAlreadyExists` on the OIDC provider** —
IAM allows only one OIDC provider per URL per AWS account. If your account
already has a `https://accounts.google.com` provider (from another tool, or a
previous run outside this Terraform state), import the existing one instead
of creating a new one:

```bash
terraform import aws_iam_openid_connect_provider.google \
  arn:aws:iam::<your-account-id>:oidc-provider/accounts.google.com
```

Before you re-run `terraform apply`, check what client IDs the existing
provider already trusts:

```bash
aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::<your-account-id>:oidc-provider/accounts.google.com \
  --query 'ClientIDList'
```

List any of those (other than linger's own) in `additional_google_oidc_client_ids`
in your `terraform.tfvars`. **This matters**: `client_id_list` is reconciled
against AWS's actual state on every apply, so any client ID missing from this
Terraform config — including ones it didn't create — gets removed from the
provider, silently breaking whatever else was relying on it. Only once
`additional_google_oidc_client_ids` accounts for everything already there is
it safe to `terraform apply`.

Note this cuts both ways: if that existing provider is itself managed by
another Terraform config (not just some other tool that used the AWS
console), importing it here too means two configs now own the same
resource. That other config's next apply won't know about linger's client
ID and may remove it in turn. Prefer adding linger's client ID as a change
to that existing config instead of importing the provider into this one,
if you have the option.
