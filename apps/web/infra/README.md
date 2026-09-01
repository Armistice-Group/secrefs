# secrefs.com infrastructure

AWS CDK stack: Route 53 (DNS) + ACM (TLS, DNS-validated) + S3 (private
origin) + CloudFront (CDN, HTTPS-only, Origin Access Control - the bucket
is never public).

## Prerequisites

- A Route 53 public hosted zone already exists for the domain (this stack
  looks it up by name; it does not create the zone).
- AWS credentials for an account with permission to manage Route 53, ACM,
  S3, and CloudFront.

## Usage

```bash
cd apps/web
npm run build          # next build -> writes the static site to ./out

cd infra
npm install
npx cdk bootstrap       # once per account/region
SECREFS_DOMAIN_NAME=secrefs.com \
SECREFS_CERTIFICATE_ARN=arn:aws:acm:us-east-1:...:certificate/... \
  npx cdk deploy
```

The deploy prints `DnsRecordsToAdd` — an ALIAS for the apex and a CNAME
for `www`, both pointing at the CloudFront distribution. Add those at the
registrar to finish.

**Why us-east-1** when the rest of the account is us-east-2: CloudFront
can only reference ACM certificates from us-east-1. That is a constraint
on CloudFront itself, not a regional preference. The S3 origin sits in
the same stack; for a CDN-fronted static site its region isn't
meaningful.

`SECREFS_DOMAIN_NAME` defaults to `secrefs.com` if unset. The stack is
pinned to `us-east-1` regardless of your default CLI region, because
CloudFront requires ACM certificates to live there.
