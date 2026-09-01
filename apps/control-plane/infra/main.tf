data "aws_caller_identity" "current" {}

# ── Secrets Manager ───────────────────────────────────────────────────────────
# App secrets live here. Terraform creates the secret with placeholders;
# update via Console/CLI after first apply — the ignore_changes below
# prevents future applies from overwriting your values.
#
# Only the values Terraform genuinely cannot know are in here. The RDS
# master password is deliberately NOT one of them: it lives in its own
# AWS-managed secret that Terraform never sees at all (see module "rds").
#
# WORKOS_API_KEY / WORKOS_CLIENT_ID are placeholders rather than required
# inputs because the app treats them as optional — and that is exactly why
# they matter here. With either unset the server still boots, prints a
# warning, and leaves every management endpoint (connections, roles,
# grants, service identities) UNAUTHENTICATED. That is a defensible default
# for `docker compose up` on a laptop and an unacceptable one for something
# behind a public ALB, so filling these in is a required step of the first
# deploy, not an optional one. See README's "Set the real secret values".

resource "aws_secretsmanager_secret" "app" {
  name        = "${var.name_prefix}/app"
  description = "SecRefs control plane application secrets"
  tags        = { Name = "${var.name_prefix}-app-secrets" }
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    # Static-key credential cipher. Ignored entirely when
    # var.enable_kms_cipher is true — src/crypto/selectCipher.ts prefers
    # SECREFS_CP_KMS_KEY_ID when both are present. Left in the secret
    # either way so that flipping the flag back does not need a new
    # secret written under incident conditions.
    SECREFS_CP_CIPHER_KEY = "REPLACE_ME_base64_of_exactly_32_random_bytes"
    WORKOS_API_KEY        = "REPLACE_ME_or_admin_endpoints_are_open"
    WORKOS_CLIENT_ID      = "REPLACE_ME_or_admin_endpoints_are_open"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ── KMS (credential envelope encryption) ──────────────────────────────────────
# The key under which every stored vault credential's data key is wrapped.
# This is the real access-control boundary for the whole product: the
# SQLite/Postgres row holds only ciphertext plus a wrapped data key, and
# turning that back into a customer's vault credential requires live
# kms:Decrypt on this key by an IAM principal AWS agrees is the instance
# role. Losing this key makes every stored connection permanently
# undecryptable, which is why the deletion window is the maximum rather
# than the 7-day minimum — 30 days is the window in which a mistaken
# `terraform destroy` is still recoverable.
#
# Rotation is safe to leave on: KMS keeps old key versions for decrypt, and
# the app wraps a fresh data key per credential anyway, so rotation applies
# to new writes without invalidating old envelopes.

resource "aws_kms_key" "cipher" {
  count = var.enable_kms_cipher ? 1 : 0

  description             = "SecRefs control plane credential envelope encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = { Name = "${var.name_prefix}-kms-cipher" }
}

resource "aws_kms_alias" "cipher" {
  count = var.enable_kms_cipher ? 1 : 0

  name          = "alias/${var.name_prefix}-cipher"
  target_key_id = aws_kms_key.cipher[0].key_id
}

# ── ECR (application image) ───────────────────────────────────────────────────

module "ecr" {
  source      = "./modules/ecr"
  name_prefix = var.name_prefix
}

# ── DNS + ACM ─────────────────────────────────────────────────────────────────
# Creates the ACM cert only — api_domain's DNS stays on the registrar, so
# validation and the A/CNAME record pointing at the ALB are added there by
# hand. See dns_validation_records / alb_dns outputs.

module "dns" {
  source     = "./modules/dns"
  api_domain = var.api_domain
}

# ── RDS (Postgres) ────────────────────────────────────────────────────────────
# The app's only persistent store. src/db/client.ts selects Postgres
# whenever DATABASE_URL is set and the SQLite file otherwise — there is no
# separate switch, so wiring DATABASE_URL through to the container (see the
# ec2 module) is what puts every org's connections, RBAC config, and audit
# log here instead of on the instance's disk. That is also what makes the
# instance disposable.

module "rds" {
  source      = "./modules/rds"
  name_prefix = var.name_prefix

  vpc_id     = aws_vpc.main.id
  subnet_ids = [for k in ["a", "b"] : aws_subnet.private[k].id]
  sg_ec2_id  = module.ec2.sg_ec2_id

  instance_class       = var.rds_instance_class
  allocated_storage_gb = var.rds_allocated_storage_gb
  db_name              = var.db_name
  db_username          = var.db_username

  deletion_protection = var.deletion_protection
}

# ── ALB security group ────────────────────────────────────────────────────────
# The only thing in this VPC with an ingress rule open to the internet.

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "SecRefs control plane ALB - inbound HTTP/S from internet"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP (redirected to HTTPS at the listener)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "${var.name_prefix}-sg-alb" }
}

# ── EC2 (single instance) + ALB ───────────────────────────────────────────────
# depends_on because ordering matters at boot, not just at plan time: the
# instance's user_data pulls from ECR and reads Secrets Manager over the
# interface endpoints, and with NAT disabled those endpoints are its only
# route to AWS at all. Terraform would otherwise happily create the
# instance in parallel with them and leave a box that failed its bootstrap
# for reasons nothing in the plan explains.

module "ec2" {
  source      = "./modules/ec2"
  name_prefix = var.name_prefix
  aws_region  = var.aws_region

  # Networking — ALB in the public subnets, instance in a private one
  vpc_id              = aws_vpc.main.id
  public_subnet_ids   = [for k in ["a", "b"] : aws_subnet.public[k].id]
  private_subnet_id   = aws_subnet.private["a"].id
  public_instance     = var.public_instance
  sg_alb_id           = aws_security_group.alb.id
  acm_certificate_arn = module.dns.certificate_arn

  # Image
  ecr_repository_url = module.ecr.repository_url
  ecr_repository_arn = module.ecr.repository_arn
  app_version        = var.app_version

  # Secrets + custody
  secrets_arn        = aws_secretsmanager_secret.app.arn
  db_secret_arn      = module.rds.master_user_secret_arn
  kms_cipher_key_arn = one(aws_kms_key.cipher[*].arn)

  # Application config. api_domain is not passed through: the app has no
  # "own public URL" setting, only the CORS allowlist below.
  cors_origins = var.cors_origins
  db_host      = module.rds.endpoint
  db_port      = module.rds.port
  db_name      = var.db_name

  # EC2 / ALB config
  instance_type       = var.ec2_instance_type
  root_volume_size_gb = var.ec2_root_volume_gb
  deletion_protection = var.deletion_protection

  depends_on = [
    aws_vpc_endpoint.s3,
    aws_vpc_endpoint.interface,
    aws_route.private_nat,
  ]
}
