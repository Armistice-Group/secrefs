# ── General ───────────────────────────────────────────────────────────────────

variable "environment" {
  type    = string
  default = "prod"
}

variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "name_prefix" {
  type    = string
  default = "secrefs-cp-prod"
}

# ── Domain ────────────────────────────────────────────────────────────────────

variable "api_domain" {
  description = "FQDN the API is served on. DNS stays at the registrar — see dns_validation_records/alb_dns outputs."
  type        = string
  default     = "api.secrefs.com"
}

# ── Database (RDS) ────────────────────────────────────────────────────────────
# The app's only persistent store — see main.tf's module "rds".

variable "rds_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "rds_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "secrefs_control_plane"
}

variable "db_username" {
  type    = string
  default = "app"
}

# No rds_master_password variable, deliberately — unlike the armory-swap
# stack this is modeled on, the master password is generated and held by
# AWS (`manage_master_user_password`) rather than passed in as a tfvar.
# See modules/rds/main.tf.

# ── Application image ─────────────────────────────────────────────────────────

variable "app_version" {
  description = "Docker image tag to deploy — must match a tag pushed to ECR"
  type        = string
  default     = "latest"
}

# ── Application config ────────────────────────────────────────────────────────

variable "cors_origins" {
  description = <<-EOT
    Origins the admin console is served from, passed through as
    SECREFS_CP_CORS_ORIGINS. Empty means the app emits no CORS headers at
    all, which is correct until the console is deployed — it is an explicit
    allowlist by design, never a wildcard.
  EOT
  type        = list(string)
  default     = []
}

variable "enable_kms_cipher" {
  description = <<-EOT
    Use a real KMS key for credential envelope encryption
    (SECREFS_CP_KMS_KEY_ID) instead of the static base64 cipher key
    (SECREFS_CP_CIPHER_KEY) out of Secrets Manager. This is the production
    custody path — src/crypto/kmsCipher.ts mints a fresh data key per
    credential and binds it to the org via KMS EncryptionContext, so a
    stolen database file is worthless without live kms:Decrypt on this key.
    Set false only for a deployment that deliberately wants the static-key
    cipher (self-hoster parity, key escrow outside AWS).
  EOT
  type        = bool
  default     = true
}

# ── EC2 ───────────────────────────────────────────────────────────────────────

variable "ec2_instance_type" {
  type    = string
  default = "t3.small"
}

variable "ec2_root_volume_gb" {
  description = "OS and container images only — application state lives in RDS, not on this volume."
  type        = number
  default     = 30
}

# No ec2_ssh_key_name / ec2_ssh_allowed_cidr, deliberately. This instance
# has no keypair and no port 22 at all; shell access is SSM Session Manager
# only. See modules/ec2/main.tf.

# ── Networking ────────────────────────────────────────────────────────────────

variable "alb_allowed_cidrs" {
  description = <<-EOT
    Who can reach the load balancer. Defaults to the whole internet,
    which is what a launched API wants.

    Narrow it to your own address for the window between the first apply
    and setting real WORKOS_* secrets. Until those are set the app boots
    with every management endpoint UNAUTHENTICATED - anyone who can reach
    it can create orgs, connections, roles and grants - and a warning on
    stdout is the only thing marking that. This variable is how you make
    that window structural rather than something you have to hurry
    through.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = length(var.alb_allowed_cidrs) > 0
    error_message = "alb_allowed_cidrs must list at least one CIDR; an empty list would create a load balancer nothing can reach."
  }
}

variable "public_instance" {
  description = <<-EOT
    Place the app instance in a public subnet with a public IP rather
    than a private subnet behind NAT. Default true: it is what the rest
    of this portfolio does and it removes roughly $99/month of egress
    infrastructure (a NAT gateway plus seven interface endpoints), which
    is most of this stack's bill.

    The instance is routable in this mode, but its security group admits
    only the app port from the ALB, so it is not reachable as a service.
    Set false - with enable_nat_gateway or enable_vpc_endpoints on - for
    the stronger posture where the box is structurally unreachable.
  EOT
  type        = bool
  default     = true

  validation {
    # A private instance needs *some* egress or it cannot pull its image,
    # read its secrets, or fetch the RDS CA bundle - it boots broken and
    # is unrecoverable except by replacement, with no SSM to debug it.
    # Catch that at plan time rather than after a 10-minute apply.
    condition     = var.public_instance || var.enable_nat_gateway || var.enable_vpc_endpoints
    error_message = "public_instance = false requires enable_nat_gateway or enable_vpc_endpoints; a private instance with neither has no route to ECR, Secrets Manager, or SSM and cannot boot."
  }
}

variable "enable_vpc_endpoints" {
  description = <<-EOT
    Create interface VPC endpoints for the AWS services this instance talks
    to. Two reasons, in priority order: (1) the calls that carry credential
    material — Secrets Manager, KMS, STS — never traverse the public
    internet or a shared NAT device at all, which is the whole point for a
    service whose job is brokering other people's vault credentials; (2) it
    covers every AWS call the bootstrap makes, so the instance is one step
    (the RDS CA bundle — see user_data.sh.tpl) away from booting with no
    internet route whatsoever.
    Costs roughly $7/mo per endpoint (see README's cost section) — turning
    this off is a real saving, at the price of routing all of the above out
    through the NAT gateway instead.
  EOT
  type        = bool
  default     = false
}

variable "enable_nat_gateway" {
  description = <<-EOT
    Egress to the public internet for the private subnets. Required in
    practice, despite the VPC endpoints above, for two reasons.

    At boot: the bootstrap fetches Amazon's RDS certificate authority
    bundle from truststore.pki.rds.amazonaws.com, which has no VPC
    endpoint. Without it the app cannot complete a TLS handshake with its
    own database (src/db/postgresDriver.ts verifies the server cert, and
    RDS's CA is in no public trust store).

    At runtime: the app calls two kinds of third-party HTTPS service that
    have no AWS endpoint — WorkOS (src/auth/workos.ts, admin auth) and
    OIDC issuer JWKS URLs (src/auth/oidc.ts, e.g.
    token.actions.githubusercontent.com). Bitwarden connections are NOT
    among them: src/providers/bitwarden.ts makes no outbound call, it
    decrypts the stored token and returns it for the caller's SDK to use.

    Set false only for a deployment that pre-bakes the CA bundle and uses
    AWS vault connections exclusively, with no WorkOS admin auth and no
    OIDC federation — and understand that without WorkOS every management
    endpoint is UNAUTHENTICATED (see the boot warning in src/server.ts).
  EOT
  type        = bool
  default     = false
}

# ── Feature flags ─────────────────────────────────────────────────────────────

variable "deletion_protection" {
  description = "Enable deletion protection on the ALB and RDS. Set false for dev to allow terraform destroy."
  type        = bool
  default     = false
}
