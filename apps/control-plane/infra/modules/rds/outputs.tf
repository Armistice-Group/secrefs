output "endpoint" { value = aws_db_instance.this.address }
output "port" { value = aws_db_instance.this.port }
output "db_name" { value = aws_db_instance.this.db_name }
output "sg_rds_id" { value = aws_security_group.rds.id }

# The AWS-managed secret holding {username, password}. The app instance
# reads this at boot to assemble DATABASE_URL; it is also the only place a
# human can get the master password from.
output "master_user_secret_arn" {
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}
