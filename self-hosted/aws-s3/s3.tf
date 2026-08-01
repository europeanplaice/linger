resource "aws_s3_bucket" "diary" {
  bucket = var.bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "diary" {
  bucket = aws_s3_bucket.diary.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "diary" {
  bucket                  = aws_s3_bucket.diary.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "diary" {
  bucket = aws_s3_bucket.diary.id
  rule {
    apply_server_side_encryption_by_default {
      # SSE-S3 (AES256). `bucket_key_enabled` is intentionally omitted: it only
      # affects SSE-KMS (where it enables the S3 bucket key to reduce KMS cost)
      # and is silently ignored for AES256, so setting it here would just mislead.
      sse_algorithm = "AES256"
    }
  }
}

# Versioning keeps every PutObject version (so a stale concurrent write can be
# recovered), but versions accumulate forever unless pruned. Bound retention of
# noncurrent versions and expired delete markers: 30 days of old versions is
# plenty for the "recover from a botched resync" case, and capping it also keeps
# the cost of a long-lived account flat instead of growing a version for every
# save, forever.
resource "aws_s3_bucket_lifecycle_configuration" "diary" {
  bucket = aws_s3_bucket.diary.id
  rule {
    id     = "prune-noncurrent-versions"
    status = "Enabled"
    filter {
      prefix = "diary-"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    noncurrent_version_transition {
      noncurrent_days = 7
      storage_class   = "STANDARD_IA"
    }
    expiration {
      expired_object_delete_marker = true
    }
  }
}
