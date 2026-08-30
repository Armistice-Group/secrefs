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
SECREFS_DOMAIN_NAME=secrefs.com npx cdk deploy
```

`SECREFS_DOMAIN_NAME` defaults to `secrefs.com` if unset. The stack is
pinned to `us-east-1` regardless of your default CLI region, because
CloudFront requires ACM certificates to live there.
