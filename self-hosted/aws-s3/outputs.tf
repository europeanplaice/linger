output "role_arn" {
  description = "Paste this into linger's Settings as your S3 Role ARN"
  value       = aws_iam_role.linger_s3.arn
}

output "bucket_name" {
  description = "The S3 bucket linger will read/write your diary data in"
  value       = aws_s3_bucket.diary.bucket
}
