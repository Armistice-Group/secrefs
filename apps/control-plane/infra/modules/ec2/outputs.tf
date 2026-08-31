# ── ALB (consumed by root outputs; the registrar record points here) ──────────
output "alb_dns" { value = aws_lb.main.dns_name }
output "alb_zone_id" { value = aws_lb.main.zone_id }
output "alb_arn" { value = aws_lb.main.arn }
output "target_group_arn" { value = aws_lb_target_group.app.arn }

# ── EC2 instance ──────────────────────────────────────────────────────────────
output "instance_id" { value = aws_instance.app.id }

# Private address only — this instance has no public IP by design. Reach it
# with `aws ssm start-session --target <instance_id>`.
output "instance_private_ip" { value = aws_instance.app.private_ip }

output "sg_ec2_id" { value = aws_security_group.ec2.id }
output "iam_role_arn" { value = aws_iam_role.ec2.arn }
output "log_group_name" { value = aws_cloudwatch_log_group.app.name }
