#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/user-data.log | logger -t user-data) 2>&1

echo "=== SecRefs control plane bootstrap starting ==="

# Amazon Linux 2023. Everything below reaches AWS service endpoints only —
# no third-party download, no distribution mirror outside AWS — so this
# script completes on an instance with no route to the internet at all
# (see network.tf's VPC endpoints). Keep it that way: adding a `curl` to
# some vendor's install script here silently makes the NAT gateway a
# prerequisite for the instance being able to boot.
#
# On the heredocs below: they are single-quoted so *bash* leaves the
# generated scripts' own $VARIABLES alone, but Terraform's templatefile()
# has already run by then, so a dollar-brace reference is still
# substituted; a literal one would need its dollar sign doubled.

# ── Packages ──────────────────────────────────────────────────────────────────
# docker: the runtime. jq: parsing Secrets Manager JSON below.
# The AWS CLI v2 and the SSM agent are already in the AMI.
dnf -y update
dnf -y install docker jq

systemctl enable --now docker
echo "Docker installed: $(docker --version)"

install -d -m 0755 /opt/secrefs

# No application data directory. All persistent state — connections, RBAC
# config, the audit log — lives in the RDS instance now that the app reads
# DATABASE_URL (src/db/client.ts picks Postgres whenever it is set). This
# host holds nothing that would be missed if it were replaced, which is the
# property the whole design depends on.

# ── Amazon RDS certificate authority ──────────────────────────────────────────
# The app verifies the database server's certificate (rejectUnauthorized:
# true in src/db/postgresDriver.ts, and SECREFS_CP_DB_SSL=false is
# explicitly not an option against RDS). RDS certificates chain to Amazon's
# own RDS root CA, which is not in any public trust store — so without this
# bundle, node-postgres fails the handshake and the app cannot reach its
# database at all.
#
# This is the one step in the bootstrap that reaches outside AWS, and it is
# therefore the one thing that needs the NAT gateway to be enabled. If you
# run with enable_nat_gateway = false, bake the bundle into the AMI or the
# image instead — the failure is loud (a TLS error at startup) rather than
# silent, but it is still a failure.
if curl -fsS --max-time 30 \
    "https://truststore.pki.rds.amazonaws.com/${aws_region}/${aws_region}-bundle.pem" \
    -o /opt/secrefs/rds-ca.pem; then
  chmod 644 /opt/secrefs/rds-ca.pem
  echo "RDS CA bundle installed"
else
  rm -f /opt/secrefs/rds-ca.pem
  echo "WARNING: could not fetch the RDS CA bundle — the app will fail to connect to Postgres over TLS"
fi

# ── ECR login ─────────────────────────────────────────────────────────────────
# ECR authorization tokens expire after ~12h. A login performed once at
# boot and never refreshed means any later restart — a deploy, a crash
# loop, a reboot — fails its pull with a 401 long after anyone would think
# to connect the two. So: one script, called immediately before every
# container start AND on a standing timer, so credentials are fresh both
# when a deploy asks for them and when nothing has asked in a week.
cat > /opt/secrefs/ecr-login.sh << 'ECRLOGIN_EOF'
#!/bin/bash
set -euo pipefail
aws ecr get-login-password --region "${aws_region}" \
  | docker login --username AWS --password-stdin "${ecr_registry}"
ECRLOGIN_EOF
chmod 700 /opt/secrefs/ecr-login.sh

cat > /etc/systemd/system/ecr-login.service << 'SERVICE_EOF'
[Unit]
Description=Refresh ECR docker login
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/secrefs/ecr-login.sh
SERVICE_EOF

cat > /etc/systemd/system/ecr-login.timer << 'TIMER_EOF'
[Unit]
Description=Periodically refresh ECR docker login (tokens expire ~12h)

[Timer]
OnBootSec=2min
OnUnitActiveSec=4h
Persistent=true

[Install]
WantedBy=timers.target
TIMER_EOF

# ── Environment file renderer ─────────────────────────────────────────────────
# Rebuilt from Secrets Manager on every start rather than written once at
# boot: rotating a WorkOS key or the database password then takes effect on
# the next `systemctl restart secrefs-control-plane`, with no Terraform run
# and no instance replacement. Nothing secret is ever written into
# user_data itself — user_data is readable through IMDS by anything running
# on this host, including a compromised app process, which for a service
# that brokers other people's vault credentials is not a place to put
# credentials of its own.
cat > /opt/secrefs/render-env.sh << 'RENDERENV_EOF'
#!/bin/bash
set -euo pipefail

ENV_FILE=/opt/secrefs/app.env
TMP_FILE=$(mktemp /opt/secrefs/.app.env.XXXXXX)
chmod 600 "$TMP_FILE"

# Infrastructure values — known to Terraform, no secret content.
# SECREFS_CP_DB_PATH is deliberately absent: DATABASE_URL below takes
# precedence anyway, and setting a SQLite path that would only ever be used
# if DATABASE_URL went missing is how you end up serving an empty database
# without noticing.
cat >> "$TMP_FILE" << 'STATIC_EOF'
NODE_ENV=production
PORT=8787
STATIC_EOF

# Node only reads extra CAs from a file path given at process start, so
# this points at the bundle's path *inside* the container (mounted by
# start.sh). Omitted entirely if the bundle is missing, so the resulting
# TLS failure names the real cause rather than a bad path.
if [ -f /opt/secrefs/rds-ca.pem ]; then
  echo "NODE_EXTRA_CA_CERTS=/etc/ssl/rds-ca.pem" >> "$TMP_FILE"
fi

# CORS: only emitted when origins were configured. Unset means the app
# sends no CORS headers at all, which is the correct state until the admin
# console exists — it is an allowlist, never a wildcard.
CORS_ORIGINS="${cors_origins}"
if [ -n "$CORS_ORIGINS" ]; then
  echo "SECREFS_CP_CORS_ORIGINS=$CORS_ORIGINS" >> "$TMP_FILE"
fi

# KMS custody. When set, src/crypto/selectCipher.ts prefers this over
# SECREFS_CP_CIPHER_KEY even if both are present.
KMS_KEY_ARN="${kms_cipher_key_arn}"
if [ -n "$KMS_KEY_ARN" ]; then
  echo "SECREFS_CP_KMS_KEY_ID=$KMS_KEY_ARN" >> "$TMP_FILE"
  echo "SECREFS_CP_KMS_REGION=${aws_region}" >> "$TMP_FILE"
fi

# DATABASE_URL — assembled from the AWS-managed RDS secret, which is the
# only copy of that password anywhere. Setting it is what selects Postgres
# over SQLite (src/db/client.ts); there is no separate switch, so an
# instance that cannot read this secret must fail rather than quietly fall
# back to a local file. Username and password are URL-encoded because a
# generated password may legally contain characters that mean something in
# a URI.
DB_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id "${db_secret_arn}" \
  --region "${aws_region}" \
  --query SecretString \
  --output text)
DB_USER=$(echo "$DB_SECRET" | jq -rj '.username | @uri')
DB_PASS=$(echo "$DB_SECRET" | jq -rj '.password | @uri')
echo "DATABASE_URL=postgresql://$DB_USER:$DB_PASS@${db_host}:${db_port}/${db_name}" >> "$TMP_FILE"
unset DB_SECRET DB_PASS

# Application secrets. Placeholder values are skipped rather than passed
# through: an unreplaced SECREFS_CP_CIPHER_KEY would make the app exit at
# startup with a base64 length error, whereas omitting it produces the
# actual message describing what to set (src/crypto/selectCipher.ts). An
# unreplaced WORKOS_* pair matters more — omitted, the server prints its
# "management endpoints are UNAUTHENTICATED" warning at boot, which is the
# signal you want in the log of an internet-facing deployment.
APP_SECRETS=$(aws secretsmanager get-secret-value \
  --secret-id "${secrets_arn}" \
  --region "${aws_region}" \
  --query SecretString \
  --output text)

for key in SECREFS_CP_CIPHER_KEY WORKOS_API_KEY WORKOS_CLIENT_ID; do
  value=$(echo "$APP_SECRETS" | jq -r --arg k "$key" '.[$k] // empty')
  case "$value" in
    ""|REPLACE_ME*) continue ;;
  esac
  echo "$key=$value" >> "$TMP_FILE"
done
unset APP_SECRETS

mv "$TMP_FILE" "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "rendered $ENV_FILE"
RENDERENV_EOF
chmod 700 /opt/secrefs/render-env.sh

# ── Start script ──────────────────────────────────────────────────────────────
# `docker run --restart unless-stopped` rather than compose: one container,
# no dependency graph to express, and the restart policy means Docker
# itself brings the app back after a crash or a reboot without waiting for
# systemd to run anything.
#
# The explicit `docker pull` is load-bearing. Without it, re-running this
# against an unchanged `:latest` tag reuses whatever layer cache is already
# on disk and silently keeps serving the previous build — the deploy
# appears to succeed and changes nothing.
cat > /opt/secrefs/start.sh << 'START_EOF'
#!/bin/bash
set -euo pipefail

IMAGE="${ecr_repository_url}:${app_version}"

/opt/secrefs/ecr-login.sh
/opt/secrefs/render-env.sh

docker pull "$IMAGE"
docker rm -f secrefs-control-plane 2>/dev/null || true

# Conditional rather than unconditional: a bind mount whose source does not
# exist makes Docker create a *directory* there, which would turn a missing
# CA bundle into a confusing "not a file" error instead of the TLS failure
# that actually explains the problem.
MOUNTS=()
if [ -f /opt/secrefs/rds-ca.pem ]; then
  MOUNTS+=(-v /opt/secrefs/rds-ca.pem:/etc/ssl/rds-ca.pem:ro)
fi

docker run -d \
  --name secrefs-control-plane \
  --restart unless-stopped \
  --env-file /opt/secrefs/app.env \
  -p 8787:8787 \
  "$${MOUNTS[@]}" \
  --log-driver=awslogs \
  --log-opt awslogs-region="${aws_region}" \
  --log-opt awslogs-group="${log_group_name}" \
  --log-opt awslogs-stream=control-plane \
  "$IMAGE"

docker image prune -f >/dev/null 2>&1 || true
echo "secrefs-control-plane started from $IMAGE"
START_EOF
chmod 700 /opt/secrefs/start.sh

# ── systemd unit ──────────────────────────────────────────────────────────────
# Type=oneshot: the unit's job is to (re)create the container, not to
# supervise it — Docker's own restart policy does the supervising. This is
# also the deploy entry point: `systemctl restart secrefs-control-plane`
# over SSM re-pulls the image and re-reads Secrets Manager.
cat > /etc/systemd/system/secrefs-control-plane.service << 'SERVICE_EOF'
[Unit]
Description=SecRefs Control Plane
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/secrefs/start.sh
ExecStop=/usr/bin/docker rm -f secrefs-control-plane
TimeoutStartSec=300
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
SERVICE_EOF

systemctl daemon-reload
systemctl enable secrefs-control-plane
systemctl enable --now ecr-login.timer

# Expected to fail on the very first apply: ECR is empty until an image has
# been pushed. The unit is enabled either way, so the box recovers with one
# `systemctl restart` (or an SSM deploy) once an image exists.
systemctl start secrefs-control-plane \
  || echo "Initial start failed — check /var/log/user-data.log and 'docker logs secrefs-control-plane', then: systemctl restart secrefs-control-plane"

echo "=== SecRefs control plane bootstrap complete ==="
