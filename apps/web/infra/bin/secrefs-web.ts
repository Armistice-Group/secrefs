#!/usr/bin/env node
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { SecRefsWebStack } from "../cdk-stack";

const app = new App();

new SecRefsWebStack(app, "SecRefsWebStack", {
  domainName: process.env.SECREFS_DOMAIN_NAME ?? "secrefs.com",
  // Next.js's `output: "export"` writes the static site here.
  siteBuildPath: path.resolve(__dirname, "../../out"),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Pinned to us-east-1: CloudFront requires ACM certs in this region.
    region: "us-east-1",
  },
});
