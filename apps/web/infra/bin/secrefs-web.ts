#!/usr/bin/env node
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { SecRefsWebStack } from "../cdk-stack";

const app = new App();

const certificateArn = process.env.SECREFS_CERTIFICATE_ARN;
if (!certificateArn) {
  throw new Error(
    "SECREFS_CERTIFICATE_ARN is required - an already-validated ACM certificate in " +
      "us-east-1 covering the apex and www. DNS for this domain lives at the registrar, " +
      "so the certificate is requested and validated out of band rather than by this stack " +
      "(see cdk-stack.ts).",
  );
}

new SecRefsWebStack(app, "SecRefsWebStack", {
  domainName: process.env.SECREFS_DOMAIN_NAME ?? "secrefs.com",
  // Next.js's `output: "export"` writes the static site here.
  siteBuildPath: path.resolve(__dirname, "../../out"),
  certificateArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Pinned to us-east-1 because CloudFront can only reference ACM
    // certificates from that region - an AWS constraint on CloudFront,
    // not a regional preference. The S3 origin lives here too; for a
    // CDN-fronted static site its region is not meaningful.
    region: "us-east-1",
  },
});
