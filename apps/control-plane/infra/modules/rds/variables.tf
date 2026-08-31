variable "name_prefix" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Subnets for the DB subnet group (must span 2+ AZs). Private subnets here; the instance is never publicly accessible regardless."
  type        = list(string)
}

variable "sg_ec2_id" {
  description = "Security group of the app EC2 instance — the only thing allowed to reach Postgres."
  type        = string
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "allocated_storage_gb" {
  type    = number
  default = 20
}

variable "engine_version" {
  type    = string
  default = "16"
}

variable "db_name" {
  type = string
}

variable "db_username" {
  description = "Master username. The password is generated and held by AWS — see main.tf."
  type        = string
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "deletion_protection" {
  type    = bool
  default = false
}
