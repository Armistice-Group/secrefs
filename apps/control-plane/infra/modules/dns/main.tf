# DNS for api_domain is NOT managed here — it stays on the registrar's
# nameservers, with records added there by hand. This module only creates
# the ACM cert; validation blocks on the manual CNAME below existing.
#
# One name, no SANs: this stack serves the API and nothing else. The admin
# console is a separate deployment on its own hostname, and putting its
# name on this certificate would tie the two together for no benefit.

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_domain
  validation_method = "DNS"

  lifecycle { create_before_destroy = true }

  tags = { Name = "${var.api_domain}-cert" }
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn = aws_acm_certificate.api.arn
  validation_record_fqdns = [
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.resource_record_name
  ]
}
