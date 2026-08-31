# ── VPC ───────────────────────────────────────────────────────────────────────
# A dedicated VPC, created by this stack and shared with nothing. The
# armory-swap stack this is modeled on learned the hard way that a VPC
# "borrowed" from a neighbouring project is a dependency you cannot see in
# your own plan output; that lesson is applied up front here rather than
# after the fact. For this service the isolation argument is stronger than
# convenience anyway — everything that reaches the control plane's instance
# is reaching a process that holds decryptable vault credentials.

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name_prefix}-vpc" }
}

# ── Subnets ───────────────────────────────────────────────────────────────────
# Public subnets carry the ALB (and the NAT gateway, if enabled) only.
# Private subnets carry the application instance and RDS. This split is the
# main deliberate divergence from armory-swap, which runs its instance in a
# public subnet with an Elastic IP — see modules/ec2/main.tf for why that
# is not acceptable here.
#
# Two AZs because an ALB requires subnets in at least two, and RDS requires
# a DB subnet group spanning two. The instance itself is single and lives in
# private-a; there is no autoscaling group and no second instance.

resource "aws_subnet" "public" {
  for_each = {
    a = { cidr = "10.20.1.0/24", az = "${var.aws_region}a" }
    b = { cidr = "10.20.2.0/24", az = "${var.aws_region}b" }
  }

  vpc_id                  = aws_vpc.main.id
  cidr_block              = each.value.cidr
  availability_zone       = each.value.az
  map_public_ip_on_launch = true

  tags = { Name = "${var.name_prefix}-public-${each.key}" }
}

resource "aws_subnet" "private" {
  for_each = {
    a = { cidr = "10.20.11.0/24", az = "${var.aws_region}a" }
    b = { cidr = "10.20.12.0/24", az = "${var.aws_region}b" }
  }

  vpc_id            = aws_vpc.main.id
  cidr_block        = each.value.cidr
  availability_zone = each.value.az
  # Explicitly false rather than relying on the default: a public IP on
  # this subnet would silently undo the entire reason it exists.
  map_public_ip_on_launch = false

  tags = { Name = "${var.name_prefix}-private-${each.key}" }
}

# ── Internet gateway + public routing ─────────────────────────────────────────

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name_prefix}-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.name_prefix}-rt-public" }
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# ── NAT gateway + private routing ─────────────────────────────────────────────
# One NAT gateway, not one per AZ. A per-AZ NAT is about surviving an AZ
# failure, and this stack has a single instance in a single AZ — it cannot
# survive one regardless, so paying twice for NAT would buy nothing. If this
# ever grows to a real multi-AZ fleet, that changes.
#
# The private route table exists unconditionally even when NAT is disabled:
# the S3 gateway endpoint below attaches to a route table, and the subnets
# need one that is explicitly theirs rather than falling back to the VPC's
# main table (whose contents nothing here declares).

resource "aws_eip" "nat" {
  count = var.enable_nat_gateway ? 1 : 0

  domain = "vpc"
  tags   = { Name = "${var.name_prefix}-eip-nat" }
}

resource "aws_nat_gateway" "main" {
  count = var.enable_nat_gateway ? 1 : 0

  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public["a"].id

  depends_on = [aws_internet_gateway.main]

  tags = { Name = "${var.name_prefix}-nat" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name_prefix}-rt-private" }
}

resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? 1 : 0

  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

# ── VPC endpoints ─────────────────────────────────────────────────────────────
# See var.enable_vpc_endpoints for the rationale. Note the asymmetry: the S3
# gateway endpoint is free and therefore unconditional, while the interface
# endpoints are billed per hour per AZ and are the thing the flag controls.
#
# The interface endpoints land in private-a only — the single AZ the
# instance runs in. Putting them in both AZs would double their cost to
# serve an instance that does not exist in the second one.

resource "aws_security_group" "vpc_endpoints" {
  count = var.enable_vpc_endpoints ? 1 : 0

  name        = "${var.name_prefix}-vpce"
  description = "SecRefs control plane VPC interface endpoints - HTTPS from within the VPC"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from inside the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    # Scoped to the VPC CIDR rather than the instance's own security group
    # on purpose: referencing that group here would make the endpoints
    # depend on the ec2 module, and the module already has to depend on the
    # endpoints (they must exist before the instance boots, or user_data
    # cannot reach ECR). The VPC CIDR is the entire private network and
    # nothing untrusted has an address in it.
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  tags = { Name = "${var.name_prefix}-sg-vpce" }
}

# Gateway endpoint — free, and carries two things that would otherwise be
# metered NAT traffic: ECR pulls the actual image layers from S3, and
# Amazon Linux 2023's dnf repositories are regional S3 buckets (which is
# what lets the bootstrap install Docker with no internet route at all).
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${var.name_prefix}-vpce-s3" }
}

resource "aws_vpc_endpoint" "interface" {
  for_each = var.enable_vpc_endpoints ? toset([
    "ecr.api",        # authorization token + image manifests
    "ecr.dkr",        # docker registry protocol
    "secretsmanager", # app secrets at boot, and the RDS master password
    "kms",            # credential envelope encryption (GenerateDataKey/Decrypt)
    "sts",            # sts:AssumeRole into customer accounts, per mint
    "logs",           # container logs via the awslogs driver
    "ssm",            # \
    "ssmmessages",    #  > Session Manager: the only shell access to this box
    "ec2messages",    # /
  ]) : toset([])

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private["a"].id]
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = { Name = "${var.name_prefix}-vpce-${each.key}" }
}
