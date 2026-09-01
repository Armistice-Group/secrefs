variable "name_prefix" { type = string }
variable "aws_region" { type = string }

# ── Networking ────────────────────────────────────────────────────────────────
variable "vpc_id" { type = string }

variable "public_subnet_ids" {
  description = "Public subnets for the ALB only (needs 2+ AZs). The instance is never in one of these."
  type        = list(string)
}

variable "public_instance" {
  description = <<-EOT
    Place the instance in a public subnet with a public IP, reached
    outbound via the internet gateway, instead of a private subnet behind
    a NAT gateway.

    True (the default) is what the rest of this portfolio does and costs
    roughly $99/month less: no NAT gateway, and no interface VPC
    endpoints needed for SSM or the AWS APIs the app calls. The instance
    is routable, but its security group still admits nothing except the
    app port from the ALB, so it is not reachable as a service.

    False is the stronger posture and the right end state for a service
    brokering other organisations' credentials: the box is structurally
    unreachable rather than reachable-but-firewalled. It requires
    enable_nat_gateway or enable_vpc_endpoints to be on, or the instance
    cannot fetch its image, its secrets, or the RDS CA bundle.
  EOT
  type        = bool
  default     = true
}

variable "private_subnet_id" {
  description = "Private subnet the single application instance runs in."
  type        = string
}

variable "sg_alb_id" { type = string }
variable "acm_certificate_arn" { type = string }

# ── Image ─────────────────────────────────────────────────────────────────────
variable "ecr_repository_url" { type = string }
variable "ecr_repository_arn" { type = string }
variable "app_version" {
  type    = string
  default = "latest"
}

# ── Secrets + custody ─────────────────────────────────────────────────────────
variable "secrets_arn" {
  description = "Secrets Manager ARN holding SECREFS_CP_CIPHER_KEY / WORKOS_API_KEY / WORKOS_CLIENT_ID."
  type        = string
}

variable "db_secret_arn" {
  description = "AWS-managed Secrets Manager ARN holding the RDS master {username, password}."
  type        = string
}

variable "kms_cipher_key_arn" {
  description = "KMS key for credential envelope encryption, or null to fall back to the static cipher key."
  type        = string
  default     = null
}

# ── Application ───────────────────────────────────────────────────────────────
# No api_domain here, deliberately: the app has no "own public URL" setting
# to configure (nothing like armory-swap's BETTER_AUTH_URL). It only ever
# needs to know which origins may call it, below.

variable "cors_origins" {
  description = "Origins allowed to call this API from a browser (the admin console). Empty means no CORS headers at all."
  type        = list(string)
  default     = []
}

variable "db_host" {
  description = "RDS endpoint address, assembled into DATABASE_URL at boot — which is what makes the app use Postgres rather than a local SQLite file."
  type        = string
}
variable "db_port" { type = number }
variable "db_name" { type = string }

# ── EC2 ───────────────────────────────────────────────────────────────────────
variable "instance_type" {
  type    = string
  default = "t3.small"
}

variable "root_volume_size_gb" {
  description = "OS and container images only — no application state lives on this volume."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# No ssh_key_name / ssh_allowed_cidr. This instance has no key pair and no
# port 22 rule — see the security group in main.tf.

# ── ALB ───────────────────────────────────────────────────────────────────────
variable "deletion_protection" {
  type    = bool
  default = false
}
