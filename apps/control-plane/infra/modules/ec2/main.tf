data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# ── AMI ───────────────────────────────────────────────────────────────────────
# Amazon Linux 2023 rather than armory-swap's Ubuntu, for one specific
# reason: this instance has no guaranteed route to the public internet (see
# the security-group and subnet comments below), and AL2023 is the only
# common distribution whose package repositories are regional S3 buckets
# reachable through the free S3 gateway endpoint. Ubuntu's bootstrap pulls
# from archive.ubuntu.com and download.docker.com, both of which would make
# the instance's ability to boot depend on the NAT gateway being enabled.
# AL2023 also ships the SSM agent and AWS CLI v2 preinstalled, which is the
# rest of what user_data would otherwise have to download.

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

# ── Logs ──────────────────────────────────────────────────────────────────────
# The container logs straight to CloudWatch via Docker's awslogs driver.
# Created here rather than letting the driver create it on demand
# (awslogs-create-group) so retention is actually set — the default for an
# implicitly created group is "never expire", and this log stream carries
# the app's authorization decisions.

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.name_prefix}/control-plane"
  retention_in_days = var.log_retention_days

  tags = { Name = "${var.name_prefix}-logs" }
}

# ── IAM role for the EC2 instance ─────────────────────────────────────────────
# An instance profile, not an IAM user with static keys. armory-swap uses
# aws_iam_user + aws_iam_access_key for its app's S3 access, and had a
# defensible reason (the same code path had to work against MinIO and
# possibly Cloudflare R2, neither of which can assume an IAM role). Nothing
# here has that constraint, and a long-lived access key pair on a host that
# brokers other organisations' vault credentials is precisely the artifact
# an attacker would most like to find. Instance-profile credentials rotate
# themselves, are scoped to this one instance, and cannot be copied off the
# box and reused later.

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2" {
  name               = "${var.name_prefix}-ec2"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = { Name = "${var.name_prefix}-ec2-role" }
}

# Two secret ARNs, enumerated — not a "${var.name_prefix}/*" wildcard. The
# difference matters the first time someone stores an unrelated secret
# under the same prefix and does not intend this host to be able to read it.
#
# No kms:Decrypt statement accompanies this: both secrets are encrypted
# under the AWS-managed aws/secretsmanager key, whose key policy already
# grants decrypt to principals in this account calling via Secrets Manager.
# A customer-managed key on either secret would need one added here.
resource "aws_iam_role_policy" "ec2_secrets" {
  name = "${var.name_prefix}-ec2-secrets"
  role = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [var.secrets_arn, var.db_secret_arn]
    }]
  })
}

resource "aws_iam_role_policy" "ec2_ecr" {
  name = "${var.name_prefix}-ec2-ecr"
  role = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # GetAuthorizationToken has no resource to scope to — the token it
        # returns is scoped by the pull permissions below, not by this.
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        # Pull-only. This instance never builds or pushes; CI does that and
        # then triggers a redeploy over SSM.
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = var.ecr_repository_arn
      },
    ]
  })
}

# Exactly the two operations src/crypto/kmsCipher.ts performs, on exactly
# this stack's key. Notably absent: kms:Encrypt (the app never encrypts
# with the KMS key directly — only data keys are wrapped, and
# GenerateDataKey returns them already wrapped) and any kms:*Key
# management action. An instance that can call ScheduleKeyDeletion on the
# key protecting every stored credential is a single compromised process
# away from destroying the product.
resource "aws_iam_role_policy" "ec2_kms" {
  count = var.kms_cipher_key_arn == null ? 0 : 1

  name = "${var.name_prefix}-ec2-kms"
  role = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
      Resource = [var.kms_cipher_key_arn]
    }]
  })
}

# sts:AssumeRole is what the whole service does for a living
# (src/providers/awsSts.ts assumes a *customer's* role, in the customer's
# account, with an inline session policy narrowing it further). The target
# ARNs belong to organisations that have not signed up yet, so this cannot
# be scoped to a resource list — it is scoped by every customer role's own
# trust policy instead, which must name this role explicitly and normally
# also demands an external ID.
#
# The Deny is the part that matters: without it, "assume any role" would
# include roles in *this* account, and any role here that trusts the
# account root would become a privilege-escalation path out of the app
# process. Nothing this service legitimately does ever assumes a role in
# its own account.
resource "aws_iam_role_policy" "ec2_sts" {
  name = "${var.name_prefix}-ec2-sts"
  role = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = "*"
      },
      {
        Effect   = "Deny"
        Action   = ["sts:AssumeRole"]
        Resource = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/*"
      },
    ]
  })
}

resource "aws_iam_role_policy" "ec2_logs" {
  name = "${var.name_prefix}-ec2-logs"
  role = aws_iam_role.ec2.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ]
      Resource = ["${aws_cloudwatch_log_group.app.arn}:*"]
    }]
  })
}

# SSM Session Manager — the only shell access to this instance. There is no
# key pair and no port 22, so this attachment is not a convenience: remove
# it and the box becomes unreachable by any human.
resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${var.name_prefix}-ec2"
  role = aws_iam_role.ec2.name
}

# ── Security group for the EC2 instance ──────────────────────────────────────
# One ingress rule, from one security group, on one port. No SSH rule at
# all — not "SSH restricted to an office CIDR", which is what armory-swap
# does and what tends to decay into 0.0.0.0/0 the first time someone is
# debugging from an airport. Session Manager covers the same need without
# an inbound rule existing to be widened.

resource "aws_security_group" "ec2" {
  name        = "${var.name_prefix}-ec2"
  description = "SecRefs control plane EC2 - app port from the ALB only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "App HTTP from ALB"
    from_port       = 8787
    to_port         = 8787
    protocol        = "tcp"
    security_groups = [var.sg_alb_id]
  }

  # Egress stays open. The instance has no route to the internet unless the
  # NAT gateway is enabled, so the network — not this rule — is what
  # constrains where it can reach; and when NAT is on, the app legitimately
  # needs arbitrary HTTPS out (WorkOS, Bitwarden, OIDC JWKS endpoints whose
  # hostnames are configured per-org at runtime and therefore cannot be
  # enumerated here).
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-sg-ec2" }
}

# ── EC2 instance ──────────────────────────────────────────────────────────────
# In a private subnet with no public IP and no Elastic IP — the deliberate
# divergence from armory-swap, which runs its instance in a public subnet
# with an EIP so it can be reached directly for debugging. This process
# holds decrypted vault credentials in memory and can mint new ones; it
# should not be addressable from the internet at all, only through the ALB,
# and the absence of a public IP is what makes that structural instead of a
# security-group rule someone can loosen in an incident.
#
# The trade-off is real and worth stating: there is no way to reach this
# box other than SSM Session Manager, and SSM depends on either the
# interface endpoints or the NAT gateway. Disable both and a broken deploy
# is unrecoverable except by replacing the instance.

resource "aws_instance" "app" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = var.private_subnet_id
  vpc_security_group_ids = [aws_security_group.ec2.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name

  associate_public_ip_address = false

  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    aws_region         = var.aws_region
    cors_origins       = join(",", var.cors_origins)
    db_host            = var.db_host
    db_port            = var.db_port
    db_name            = var.db_name
    db_secret_arn      = var.db_secret_arn
    secrets_arn        = var.secrets_arn
    kms_cipher_key_arn = var.kms_cipher_key_arn == null ? "" : var.kms_cipher_key_arn
    ecr_repository_url = var.ecr_repository_url
    ecr_registry       = element(split("/", var.ecr_repository_url), 0)
    app_version        = var.app_version
    log_group_name     = aws_cloudwatch_log_group.app.name
  })

  # Replace the instance (rather than update in place) if user_data changes,
  # so the new bootstrap script always runs on a clean instance.
  user_data_replace_on_change = true

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
    encrypted   = true
    # Safe to delete with the instance: nothing persistent lives on this
    # host. All state is in the RDS instance (the app selects Postgres
    # whenever DATABASE_URL is set — src/db/client.ts), so a replacement
    # costs a few minutes of downtime and no data. Still encrypted, because
    # decrypted credentials pass through this machine's memory and anything
    # that reaches swap or a core dump lands here.
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
    # The container reaches IMDS for the instance role's credentials
    # (AWS SDK inside the app, for KMS and STS), and Docker's default
    # bridge network adds a hop — so 1 is not enough here, unlike a
    # process running directly on the host.
    http_put_response_hop_limit = 2
  }

  tags = { Name = "${var.name_prefix}-ec2" }
}

# No Elastic IP. armory-swap attaches one so its instance's public address
# survives a stop/start; this instance has no public address to stabilise.

# ── Application Load Balancer ─────────────────────────────────────────────────

resource "aws_lb" "main" {
  name               = "${var.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.sg_alb_id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = var.deletion_protection
  enable_http2               = true
  idle_timeout               = 60

  # The ALB is the only public entrance to this service, so it is also the
  # only place a request's real origin is visible. Dropping malformed
  # headers rather than forwarding them keeps request-smuggling shapes from
  # reaching a process that makes authorization decisions.
  drop_invalid_header_fields = true

  tags = { Name = "${var.name_prefix}-alb" }
}

# ── Target group ──────────────────────────────────────────────────────────────
# The container publishes 8787 straight through to the host — no port
# remapping, unlike armory-swap's 3000→80. There is nothing else on this
# instance to collide with, and matching the app's own documented port
# means the target group, the security group, and `docker ps` all say the
# same number.

resource "aws_lb_target_group" "app" {
  name        = "${var.name_prefix}-tg"
  port        = 8787
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

  health_check {
    enabled             = true
    path                = "/healthz"
    protocol            = "HTTP"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 10
    interval            = 30
    matcher             = "200"
  }

  deregistration_delay = 30

  tags = { Name = "${var.name_prefix}-tg" }
}

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = 8787
}

# ── ALB listeners ─────────────────────────────────────────────────────────────
# TLS terminates here and nowhere else: the hop from ALB to instance is
# plain HTTP inside a private subnet, which is why the app never needs a
# certificate of its own (see the app README's "TLS and network exposure").

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ── CloudWatch alarm ──────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${var.name_prefix}-unhealthy-hosts"
  alarm_description   = "The EC2 instance is unhealthy in the ALB target group"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  dimensions = {
    TargetGroup  = aws_lb_target_group.app.arn_suffix
    LoadBalancer = aws_lb.main.arn_suffix
  }

  tags = { Name = "${var.name_prefix}-unhealthy-hosts-alarm" }
}
