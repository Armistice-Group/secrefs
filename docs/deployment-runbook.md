# Deployment runbook

Getting SecRefs online: three deployables, in dependency order. Nothing
here has been run — no AWS resources exist yet.

| What | Where it lands | Stack |
|---|---|---|
| Marketing site + sandbox | `secrefs.com` | CDK — `apps/web/infra` |
| Admin console | `app.secrefs.com` | CDK — same stack, second instance |
| Control plane API | `api.secrefs.com` | Terraform — `apps/control-plane/infra` |

Prerequisite for all three: a Route 53 public hosted zone for
`secrefs.com` in the target account. Both stacks look it up; neither
creates it.

---

## 0. Authenticate

```bash
aws sso login --profile <your-profile>
export AWS_PROFILE=<your-profile>
aws sts get-caller-identity          # confirm the right account before anything else
```

Everything below assumes `AWS_PROFILE` is set. Check the account id
against the one you intend — the Terraform stack grants
`sts:AssumeRole` and creates a KMS key, and doing that in the wrong
account is annoying to unpick.

---

## 1. Marketing site → `secrefs.com`

Lowest risk, no dependencies, gets the domain serving.

```bash
cd apps/web
pnpm build                       # static export → ./out

cd infra
npm install
npx cdk bootstrap                # once per account/region
SECREFS_DOMAIN_NAME=secrefs.com npx cdk deploy
```

ACM validation is DNS-based against the hosted zone, so it completes on
its own. First deploy takes ~15 minutes, mostly CloudFront distribution
creation.

---

## 2. Control plane API → `api.secrefs.com`

Do this before the admin console: the console is built against the API's
URL, so it needs to exist first.

### 2a. Plan and apply

```bash
cd apps/control-plane/infra
cp terraform.tfvars.example terraform.tfvars   # every value has a working default
terraform init
terraform plan                                  # read this properly, it creates ~40 resources
terraform apply
```

**The apply will pause on ACM certificate validation.** This stack
creates the certificate but deliberately does not manage DNS records
(the domain's records may not live in the same account as the API). Add
the validation records it prints, then the apply continues:

```bash
terraform output -json dns_validation_records
```

Since `secrefs.com` is in Route 53, adding them there is the fastest
path.

### 2b. Build and push the image

Nothing runs until an image exists in ECR. **Build from the repo root** —
the Dockerfile expects the workspace context:

```bash
cd /path/to/secrefs
aws ecr get-login-password --region <region> \
  | docker login --username AWS --password-stdin "$(cd apps/control-plane/infra && terraform output -raw ecr_repository_url | cut -d/ -f1)"

docker build -f apps/control-plane/Dockerfile -t secrefs-control-plane .
docker tag secrefs-control-plane:latest "$(cd apps/control-plane/infra && terraform output -raw ecr_repository_url):latest"
docker push "$(cd apps/control-plane/infra && terraform output -raw ecr_repository_url):latest"
```

### 2c. Set the real secrets

Terraform creates the Secrets Manager entries with `REPLACE_ME`
placeholders and `ignore_changes` on the value, so a later apply never
clobbers what you put there. Until you set them, **the API runs with
every management endpoint unauthenticated** — it prints a loud warning at
boot, and that warning is the only thing standing between an open control
plane and the internet.

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(terraform output -raw secrets_arn)" \
  --secret-string '{
    "WORKOS_API_KEY": "sk_live_...",
    "WORKOS_CLIENT_ID": "client_...",
    "SECREFS_CP_CIPHER_KEY": "<only if enable_kms_cipher = false>"
  }'
```

Then restart so it picks them up:

```bash
aws ssm send-command \
  --document-name AWS-RunShellScript \
  --instance-ids "$(terraform output -raw instance_id)" \
  --parameters 'commands=["systemctl restart secrefs-control-plane"]'
```

### 2d. Verify

```bash
curl -sf https://api.secrefs.com/healthz     # {"ok":true}
curl -s  https://api.secrefs.com/v1/config   # adminAuthRequired should be TRUE
```

If `adminAuthRequired` is `false`, WorkOS isn't wired and the API is
open. Fix that before going further.

---

## 3. Admin console → `app.secrefs.com`

Built against the API URL, so it must come last.

```bash
cd apps/control-plane-admin
NEXT_PUBLIC_CONTROL_PLANE_URL=https://api.secrefs.com pnpm build
```

Then deploy `out/` behind CloudFront — either a second instance of the
`apps/web/infra` stack pointed at `app.secrefs.com`, or any static host.

Finally, tell the API to accept the console's origin, or every request it
makes is blocked by the browser:

```bash
# in apps/control-plane/infra/terraform.tfvars
cors_origins = ["https://app.secrefs.com"]
```

`terraform apply`, then restart the service as in 2c.

---

## Order of operations, condensed

1. `aws sso login`, confirm the account
2. Marketing site (independent)
3. API: apply → add DNS validation records → push image → set secrets → restart → verify `/v1/config`
4. Console: build with the API URL → deploy → add `cors_origins` → apply → restart

## Known sharp edges

- **The `REPLACE_ME` window.** Between 2a and 2c the API is live and
  unauthenticated. Keep it short, and don't publish the domain until
  `/v1/config` reports `adminAuthRequired: true`.
- **The instance needs egress at boot**, not just at runtime: it fetches
  its image from ECR, its secrets from Secrets Manager, and Amazon's RDS
  CA bundle to verify the database's TLS certificate. On the default
  (public subnet) that comes from the internet gateway. If you set
  `public_instance = false`, you must enable NAT or the interface
  endpoints — Terraform refuses to plan the combination that can't boot.
- **Costs ~$56/mo as defaulted** (see `apps/control-plane/infra/README.md`
  for the line items) — the same shape as armory-swap and pwnbook: public
  subnet, no NAT, no interface endpoints. `public_instance = false` plus
  `enable_nat_gateway`/`enable_vpc_endpoints` buys the hardened posture
  for roughly $99/mo more, and is worth turning on once there is revenue
  to justify it.
- **`deletion_protection = false` by default.** Turn it on before the
  database holds anything you'd mind losing.
