resource "aws_ecr_repository" "app" {
  name                 = "${var.name_prefix}/app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  # The image is built from the repo root (see the Dockerfile's header) and
  # contains no secrets — every one of them arrives as an environment
  # variable at container start. Encryption here is about the layers
  # themselves, and AES256 with the ECR-owned key is enough for that; a
  # customer-managed key would add a second thing to lose without changing
  # what an attacker who pulled the image would learn.
  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "${var.name_prefix}-ecr" }
}

# Keep the last 10 images so the repo doesn't grow unbounded.
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
