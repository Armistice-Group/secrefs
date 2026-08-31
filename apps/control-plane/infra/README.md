# SecRefs Control Plane — Deployment & Infrastructure

Terraform for deploying `apps/control-plane` (the Fastify API in the parent
directory) to AWS. Single EC2 instance behind its own ALB, with its own
dedicated RDS Postgres instance, in its own VPC.

```
Internet
  │
  └─ ALB  api.secrefs.com  (HTTPS, ACM cert; HTTP→HTTPS redirect)
       │   public subnets, the only internet-facing thing in the VPC
       │
       └─ EC2 (Amazon Linux 2023, single instance, PRIVATE subnet, no public IP)
            └─ docker run --restart unless-stopped, port 8787
                 ├─ Secrets Manager  (cipher key, WorkOS credentials, DB password)
                 ├─ KMS              (credential envelope encryption)
                 ├─ RDS Postgres     (private, encrypted — all persistent state)
                 └─ CloudWatch Logs  (container stdout/stderr)
```

The instance holds no state. Everything persistent — org connections, RBAC
config, the audit log — is in RDS, because the bootstrap sets
`DATABASE_URL` and `src/db/client.ts` selects Postgres whenever it is set.
Replacing the instance costs a few minutes of downtime and no data.

This stack is modeled on the Armory Swap stack in the same portfolio
(`pewmarket/terraform/`) and follows its layout, variable naming, and
tagging conventions. Where it diverges, it diverges on purpose — see
[Divergences from armory-swap](#divergences-from-armory-swap).

---

## Prerequisites

- Terraform >= 1.6
- AWS credentials with permissions to create VPC, EC2, ELB, RDS, ECR, IAM,
  KMS, Secrets Manager, CloudWatch resources
- Docker with `buildx` (to build and push the image)
- Control of DNS for `api_domain` at whatever registrar holds it — this
  stack creates the ACM certificate but does **not** manage DNS records
- The AWS Session Manager plugin, if you want a shell on the instance
  (`aws ssm start-session`); there is no SSH.

## First-time setup

### 1. Configure and apply

```bash
cd apps/control-plane/infra
cp terraform.tfvars.example terraform.tfvars   # optional — every var has a default

terraform init
terraform plan    # review what will be created (~45 resources)
terraform apply
```

Unlike armory-swap, `terraform.tfvars` here holds no secret values at all
— there is nothing you are required to fill in before applying. (It is
still not in `.gitignore`; keep it that way only as long as that stays
true.)

> The first apply **will not finish unattended.** Two slow steps:
>
> - **ACM validation blocks.** `terraform apply` will sit on
>   `aws_acm_certificate_validation` until you add the CNAME it wants at
>   the registrar. Get it from `terraform output dns_validation_records` —
>   in a second terminal, while the apply is still waiting.
> - **RDS provisioning** takes several minutes on its own.

### 2. Point DNS at the ALB

```bash
terraform output alb_dns
```

Add a `CNAME` (or ALIAS/ANAME, if your registrar supports it at that
label) for `api.secrefs.com` → that name.

### 3. Set the real secret values

Terraform created `secrefs-cp-prod/app` with placeholder values and
`ignore_changes = [secret_string]`, so nothing you write here is ever
clobbered by a later `terraform apply`.

```bash
SECRET_ARN=$(terraform output -raw secrets_arn)

aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" --secret-string "$(cat <<EOF
{
  "SECREFS_CP_CIPHER_KEY": "$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")",
  "WORKOS_API_KEY": "sk_live_...",
  "WORKOS_CLIENT_ID": "client_..."
}
EOF
)"
```

**`WORKOS_API_KEY` and `WORKOS_CLIENT_ID` are not optional for this
deployment.** The app treats them as optional — with either unset it boots
anyway, prints a warning, and leaves every management endpoint
(connections, roles, grants, service identities) completely
unauthenticated. That is a reasonable default for `docker compose up` on a
laptop and an unacceptable one for something reachable at
`https://api.secrefs.com`. The bootstrap script deliberately does not pass
placeholder values through, so an unfilled secret produces the app's own
boot warning in CloudWatch rather than a silently open API.

`SECREFS_CP_CIPHER_KEY` is only used when `enable_kms_cipher = false`. With
the default (`true`) the app uses the KMS key this stack creates and
ignores the static key entirely — but set a real one anyway, so falling
back does not require generating a key mid-incident.

The **RDS master password is not in this secret and never passes through
Terraform**. AWS generates and holds it; read it if you need a `psql`
prompt:

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw rds_master_secret_arn)" \
  --query SecretString --output text | jq .
```

### 4. Build and push the image

ECR is empty after `terraform apply`, so the instance's first boot has
nothing to pull — that failure is expected and logged.

The Dockerfile builds **from the repo root** (it needs the workspace's
`package.json` files to resolve `pnpm-lock.yaml`):

```bash
ECR_REPO=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password --region us-east-2 \
  | docker login --username AWS --password-stdin "$(echo "$ECR_REPO" | cut -d/ -f1)"

# from the repo root:
docker buildx build \
  --platform linux/amd64 \
  -f apps/control-plane/Dockerfile \
  -t "$ECR_REPO:latest" \
  --push .
```

> **Building on an Apple Silicon Mac:** pass `--platform linux/amd64` and
> push with `buildx` in a single command, exactly as above. The instance is
> x86_64. A plain `docker build` on arm64 hardware silently produces an
> arm64 image, and a separate `docker build && docker push` can publish a
> manifest tagged with a CPU-feature variant the instance will not match —
> in both cases `docker pull` on the instance fails and the previous image
> keeps serving.

### 5. Start the app

```bash
aws ssm start-session --target "$(terraform output -raw instance_id)"
# on the instance:
sudo systemctl restart secrefs-control-plane
```

That one command is also the entire deploy procedure from then on: the
systemd unit re-runs `/opt/secrefs/start.sh`, which refreshes the ECR
login, re-reads Secrets Manager, pulls the image, and recreates the
container.

### 6. Verify

```bash
curl -fsS "$(terraform output -raw api_url)/healthz"     # {"ok":true}
curl -fsS "$(terraform output -raw api_url)/v1/config"   # which auth modes are live

aws elbv2 describe-target-health \
  --target-group-arn "$(terraform output -raw target_group_arn)"

aws logs tail "$(terraform output -raw log_group_name)" --follow
```

`GET /v1/config` is the fastest check that WorkOS is actually configured —
it reports which auth modes the running process found, and it is
unauthenticated by design.

---

## Deploying a new version

```bash
# build + push as in step 4, then:
aws ssm send-command \
  --document-name AWS-RunShellScript \
  --instance-ids "$(terraform output -raw instance_id)" \
  --parameters 'commands=["systemctl restart secrefs-control-plane"]'
```

Terraform is not involved unless `app_version` is pinned to something
other than `latest`, in which case bump the variable and apply.

Rotating a secret needs no Terraform run either — write the new value to
Secrets Manager, then restart the service. The environment file is rebuilt
from Secrets Manager on every start, precisely so that this is true.

---

## Divergences from armory-swap

Everything not listed here follows the reference stack.

| Divergence | Why |
|---|---|
| **Instance in a private subnet, no public IP, no Elastic IP.** armory-swap runs its instance in a public subnet with an EIP. | This process holds decryptable vault credentials and can mint new ones into customer accounts. It should be reachable only through the ALB, and the absence of a public address makes that structural rather than a security-group rule someone can widen during an incident. |
| **NAT gateway + VPC endpoints** (neither exists in armory-swap). | A private instance needs *some* egress. Both are provided and independently toggleable — see [Networking cost/benefit](#networking-costbenefit) below, and `variables.tf`. |
| **Amazon Linux 2023, not Ubuntu.** | Its package repositories are regional S3 buckets, reachable through the free S3 gateway endpoint. That is what lets the bootstrap install Docker with no internet route at all. Ubuntu's would need `archive.ubuntu.com` and `download.docker.com`, making the NAT gateway a prerequisite for booting. AL2023 also ships the SSM agent and AWS CLI v2 already. |
| **No SSH key pair, no port 22 rule at all.** armory-swap opens 22 to a configurable CIDR (defaulting to `0.0.0.0/0`). | SSM Session Manager covers the same need without an inbound rule existing to be widened. |
| **IAM instance profile, no IAM user or access keys.** armory-swap uses `aws_iam_user` + `aws_iam_access_key` for its app's S3 access. | It had a real reason (the same code path had to work against MinIO and possibly R2). Nothing here does, and a long-lived key pair on a host that brokers other organisations' credentials is the single most valuable artifact an attacker could find there. |
| **RDS master password via `manage_master_user_password`.** armory-swap passes it as a sensitive tfvar and interpolates `DATABASE_URL` directly into user_data. | user_data is readable through IMDS by anything running on the host, including a compromised app process. AWS generates the password, Terraform never sees it, and the instance fetches it at boot under an IAM permission scoped to that one secret ARN. |
| **Nothing secret is written into user_data.** | Same reason. The bootstrap ships a *renderer*; the values arrive from Secrets Manager at start time. |
| **`docker run --restart unless-stopped`, not docker compose.** | One container, no dependency graph to express. Docker's own restart policy supervises it. |
| **KMS key for envelope encryption.** | The production credential-custody path (`src/crypto/kmsCipher.ts`). The instance role gets `kms:GenerateDataKey` and `kms:Decrypt` on this one key and nothing else — no `kms:Encrypt`, no key management. |
| **`sts:AssumeRole` on `*` with an explicit same-account Deny.** | Assuming customers' roles is the service's core function and their ARNs are unknowable in advance. The Deny stops that from also being a path into roles in *this* account. |
| **ALB `drop_invalid_header_fields = true`, target port 8787.** | The ALB is the only place a request's real origin is visible, and this app makes authorization decisions. Port 8787 straight through means the target group, security group, and `docker ps` all say the same number. |
| **No CI/CD IAM user.** armory-swap creates one for its self-hosted runner. | No pipeline exists for this service yet. When one does, model it on armory-swap's — but prefer GitHub's OIDC provider over static keys, which is a thing this very service exists to make easy. |

---

## What this costs

Approximate `us-east-2` on-demand list prices, per month, with all
defaults. Data transfer, request charges, and log volume are usage-driven
and excluded unless noted.

| Item | Monthly |
|---|---|
| EC2 `t3.small` (730 h) | ~$15 |
| EBS gp3 root volume, 30 GB | ~$2 |
| Application Load Balancer (base + ~1 LCU) | ~$22 |
| RDS `db.t4g.micro` Postgres, single-AZ | ~$12 |
| RDS gp3 storage, 20 GB (+ 7-day backups, free at this size) | ~$2 |
| KMS customer-managed key | $1 |
| Secrets Manager, 2 secrets | ~$1 |
| ECR storage, CloudWatch Logs, ACM | ~$1 |
| **Subtotal — no egress infrastructure** | **~$56** |
| NAT gateway (`enable_nat_gateway`), + $0.045/GB processed | ~$33 |
| 9 interface VPC endpoints (`enable_vpc_endpoints`), + $0.01/GB | ~$66 |
| **Total, as configured by default** | **~$155** |

### Networking cost/benefit

Read this before turning either flag off — they are not interchangeable.

**`enable_vpc_endpoints`** (~$66/mo, ~$7.30 per endpoint) buys two
different things:

1. Calls carrying credential material — Secrets Manager, KMS, STS — never
   traverse the public internet or a shared NAT device. For a service whose
   entire job is brokering other organisations' vault credentials, that is
   the point, not an optimisation.
2. It is what lets the instance boot at all with no internet route. The
   bootstrap deliberately touches nothing outside AWS.

The commonly cited "endpoints are cheaper than NAT" claim does not hold at
this scale: nine endpoints cost roughly twice a NAT gateway. They are
worth it here for reason (1), not for the bill. The S3 *gateway* endpoint
is separate, free, and always created — it carries ECR layer pulls and
AL2023's package repositories, both of which would otherwise be metered
NAT traffic.

**`enable_nat_gateway`** (~$33/mo) is required in practice despite the
above, because the app itself calls three third-party HTTPS services that
have no AWS endpoint:

- **WorkOS** (`src/auth/workos.ts`) — admin authentication. Without it,
  every management endpoint fails closed with a verification error.
- **OIDC issuer JWKS URLs** (`src/auth/oidc.ts`) — e.g.
  `token.actions.githubusercontent.com` for GitHub Actions federation,
  and WorkOS's own JWKS for admin sessions.

Bitwarden connections are *not* on this list, despite what you might
expect: `src/providers/bitwarden.ts` makes no outbound call at all. It
decrypts the org's stored access token and returns it — the SDK on the
caller's side is what talks to Bitwarden. AWS connections do call STS,
but that goes over the interface endpoint, not NAT.

Turn it off only for a deployment that uses AWS vault connections
exclusively, with no WorkOS admin auth and no OIDC federation — and read
the WorkOS warning in step 3 again before you do.

**Turning off both leaves an instance that cannot boot, cannot be
reached by SSM, and cannot be recovered except by replacement.** Nothing
prevents that combination; this paragraph is the only guardrail.

---

## Known limitations

- **The RDS CA bundle is fetched over the internet at boot.** It is the one
  thing in the bootstrap that does not come from an AWS service endpoint,
  and it is why `enable_nat_gateway = false` is not usable as written —
  without the bundle the app cannot complete a TLS handshake with its own
  database. Baking it into the AMI or the container image would remove the
  last reason a NAT-less deployment cannot boot.
- **Single instance, single AZ.** The ALB and DB subnet group span two AZs
  because AWS requires it, but there is no second instance and no
  autoscaling group. An AZ failure is an outage; an instance replacement is
  a few minutes of downtime.
- **No CI/CD.** Deploys are the `aws ssm send-command` above, run by hand.
- **Terraform state is local-only** — no remote backend or locking
  configured yet. The `backend "s3"` block in `versions.tf` is commented
  out and ready.
- **DNS is manual**, at the registrar. This stack creates the ACM
  certificate and nothing else DNS-related, matching armory-swap.
