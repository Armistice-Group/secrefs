# ── DB subnet group ───────────────────────────────────────────────────────────
# Genuinely private subnets, unlike the armory-swap stack this is modeled
# on, which had no private subnets to offer its database and leaned on
# publicly_accessible = false plus a security group instead. Both defences
# are still here; this one is simply the layer that does not depend on
# getting the other two right.

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db-subnet-group"
  subnet_ids = var.subnet_ids
  tags       = { Name = "${var.name_prefix}-db-subnet-group" }
}

# ── Security group ────────────────────────────────────────────────────────────
# Only the control plane's own EC2 instance may reach Postgres — a
# dedicated, single-tenant instance, not shared with any other app.

resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "SecRefs control plane RDS - Postgres from the app EC2 instance only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Postgres from app EC2"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.sg_ec2_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-sg-rds" }
}

# ── RDS instance ──────────────────────────────────────────────────────────────
# manage_master_user_password is the one substantive change from
# armory-swap's otherwise identical instance. There, the master password is
# a sensitive tfvar: it sits in terraform.tfvars, in state, and — because
# the bootstrap script interpolates DATABASE_URL directly — in the
# instance's user_data, which any process that can reach IMDS can read
# back verbatim. For a service whose threat model explicitly includes "the
# app process is compromised," handing that process its own database
# credentials in plaintext through a side channel is not defensible.
#
# Instead AWS generates the password, holds it in a Secrets Manager secret
# Terraform never reads, and the instance fetches it at boot with an IAM
# permission scoped to that one secret ARN. The consequence to know about:
# nothing outside AWS has a copy, so `aws secretsmanager get-secret-value`
# on master_user_secret_arn is the only way to get a psql prompt.

resource "aws_db_instance" "this" {
  identifier     = "${var.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage = var.allocated_storage_gb
  storage_type      = "gp3"
  storage_encrypted = true

  db_name                     = var.db_name
  username                    = var.db_username
  manage_master_user_password = true
  port                        = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period = var.backup_retention_days
  backup_window           = "07:00-08:00"
  maintenance_window      = "sun:08:30-sun:09:30"

  auto_minor_version_upgrade = true
  deletion_protection        = var.deletion_protection
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name_prefix}-postgres-final"

  apply_immediately = false

  tags = { Name = "${var.name_prefix}-rds" }
}
