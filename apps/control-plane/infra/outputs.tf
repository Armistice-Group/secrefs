output "api_url" {
  value = "https://${var.api_domain}"
}

output "alb_dns" {
  description = "ALB DNS name — add manually at the registrar: CNAME (or ALIAS) api -> this"
  value       = module.ec2.alb_dns
}

output "dns_validation_records" {
  description = "ACM validation records — add manually at the registrar before the cert can validate"
  value       = module.dns.validation_records
}

output "instance_id" {
  description = "EC2 instance ID (for aws ssm start-session --target)"
  value       = module.ec2.instance_id
}

output "instance_private_ip" {
  description = "No public IP exists — the instance is private by design. See modules/ec2/main.tf."
  value       = module.ec2.instance_private_ip
}

output "ssm_session_command" {
  description = "The only shell access to the instance — there is no SSH key pair and no port 22."
  value       = "aws ssm start-session --target ${module.ec2.instance_id} --region ${var.aws_region}"
}

output "ecr_repository_url" {
  value = module.ecr.repository_url
}

output "ecr_repository_arn" {
  value = module.ecr.repository_arn
}

output "target_group_arn" {
  value = module.ec2.target_group_arn
}

output "log_group_name" {
  description = "CloudWatch log group carrying the container's stdout/stderr"
  value       = module.ec2.log_group_name
}

output "secrets_arn" {
  description = "Secrets Manager ARN — set the real values here before first deploy (see README)"
  value       = aws_secretsmanager_secret.app.arn
}

output "kms_cipher_key_arn" {
  description = "KMS key backing SECREFS_CP_KMS_KEY_ID, or null when var.enable_kms_cipher is false"
  value       = one(aws_kms_key.cipher[*].arn)
}

output "rds_endpoint" {
  value = module.rds.endpoint
}

output "rds_master_secret_arn" {
  description = "AWS-managed secret holding the RDS master credentials — the only copy of that password"
  value       = module.rds.master_user_secret_arn
}

output "instance_arn" {
  value = "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/${module.ec2.instance_id}"
}
