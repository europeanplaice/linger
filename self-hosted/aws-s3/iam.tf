# Both conditions are required. 'aud' alone would let ANY signed-in linger user
# assume this role (every linger user's id_token shares the same aud). 'sub' pins
# it to your own Google account so only your linger session can use it.
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.google.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "accounts.google.com:aud"
      values   = [var.linger_google_client_id]
    }

    condition {
      test     = "StringEquals"
      variable = "accounts.google.com:sub"
      values   = [var.linger_google_sub]
    }
  }
}

resource "aws_iam_role" "linger_s3" {
  name               = "linger-s3-self-hosted"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_iam_policy_document" "s3_access" {
  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.diary.arn}/*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.diary.arn]
  }
}

resource "aws_iam_role_policy" "linger_s3" {
  name   = "linger-s3-access"
  role   = aws_iam_role.linger_s3.id
  policy = data.aws_iam_policy_document.s3_access.json
}
