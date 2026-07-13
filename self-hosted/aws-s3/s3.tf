resource "aws_s3_bucket" "diary" {
  bucket = var.bucket_name
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
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}
