import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

export interface SecRefsWebStackProps extends StackProps {
  /** The apex domain to serve, e.g. "secrefs.com". Must have a Route 53 hosted zone. */
  domainName: string;
  /** Path to the built static site (Next.js `output: "export"` -> `out/`). */
  siteBuildPath: string;
}

/**
 * Hosts the secrefs.com static site: Route 53 (DNS) + ACM (TLS) + S3
 * (origin storage) + CloudFront (CDN/edge). The bucket itself is never
 * public - CloudFront reaches it exclusively via Origin Access Control.
 *
 * Deploy from us-east-1: CloudFront requires ACM certificates to live in
 * that region regardless of where the distribution's edge locations serve
 * traffic from, so this stack's `env.region` should be pinned there (see
 * bin/secrefs-web.ts).
 */
export class SecRefsWebStack extends Stack {
  constructor(scope: Construct, id: string, props: SecRefsWebStackProps) {
    super(scope, id, props);

    const { domainName, siteBuildPath } = props;
    const wwwDomainName = `www.${domainName}`;

    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName,
    });

    const certificate = new acm.Certificate(this, "Certificate", {
      domainName,
      subjectAlternativeNames: [wwwDomainName],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      bucketName: `${domainName}-site`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      domainNames: [domainName, wwwDomainName],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      // `next export` writes flat HTML files (e.g. /providers -> providers.html),
      // so a 403/404 from S3 for an extension-less path falls back to the
      // static 404 page rather than CloudFront's default XML error blob.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: "/404.html",
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: "/404.html",
          ttl: Duration.minutes(5),
        },
      ],
    });

    new route53.ARecord(this, "ApexAliasRecord", {
      zone: hostedZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new route53.AaaaRecord(this, "ApexAliasRecordV6", {
      zone: hostedZone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new route53.ARecord(this, "WwwAliasRecord", {
      zone: hostedZone,
      recordName: wwwDomainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [s3deploy.Source.asset(path.resolve(siteBuildPath))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });

    new CfnOutput(this, "DistributionDomainName", {
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, "SiteUrl", {
      value: `https://${domainName}`,
    });
    new CfnOutput(this, "BucketName", {
      value: siteBucket.bucketName,
    });
  }
}
