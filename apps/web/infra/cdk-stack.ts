import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

export interface SecRefsWebStackProps extends StackProps {
  /** The apex domain to serve, e.g. "secrefs.com". */
  domainName: string;
  /** Path to the built static site (Next.js `output: "export"` -> `out/`). */
  siteBuildPath: string;
  /**
   * ARN of an *already validated* ACM certificate in us-east-1 covering
   * the apex and www.
   *
   * Passed in rather than created here because DNS for this domain lives
   * at the registrar, not Route 53. A certificate this stack created
   * would block the deploy on DNS validation records nobody can add
   * until CloudFormation has already printed them - so it is requested
   * out of band, validated, and referenced by ARN.
   */
  certificateArn: string;
}

/**
 * Hosts the secrefs.com static site: ACM (TLS) + S3 (origin storage) +
 * CloudFront (CDN/edge). The bucket itself is never public - CloudFront
 * reaches it exclusively via Origin Access Control.
 *
 * **This stack manages no DNS.** secrefs.com is served by the
 * registrar's nameservers, so the two records that point the domain at
 * this distribution are added there by hand; the stack outputs what they
 * should contain. That is also why the certificate is an input rather
 * than something created here - see `certificateArn`.
 *
 * Deploy from us-east-1: CloudFront requires ACM certificates to live in
 * that region regardless of where its edge locations serve traffic from.
 * That is an AWS constraint on CloudFront specifically, not a preference
 * - a distribution cannot reference a certificate from anywhere else.
 */
export class SecRefsWebStack extends Stack {
  constructor(scope: Construct, id: string, props: SecRefsWebStackProps) {
    super(scope, id, props);

    const { domainName, siteBuildPath } = props;
    const wwwDomainName = `www.${domainName}`;

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "Certificate",
      props.certificateArn,
    );

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      bucketName: `${domainName}-site`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // `next export` writes flat files - /for-vendors becomes
    // for-vendors.html - but S3 is a key-value store with no notion of
    // extension resolution, so a request for /for-vendors misses and falls
    // through to the 404 page below. Every route except "/" would be dead
    // in production while working locally, because `next dev` and static
    // file servers both resolve the extension for you.
    const rewriteToHtml = new cloudfront.Function(this, "RewriteToHtml", {
      comment: "Map extension-less paths onto the flat .html files next export writes",
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // "/" is the only path that maps to a directory index, because
  // next export with trailingSlash:false writes flat files everywhere
  // else. Root is served by defaultRootObject, so nothing to do.
  if (uri === "/") {
    return request;
  }

  // A trailing slash on any other path would resolve to a directory
  // index that does not exist. Redirect to the canonical slash-less
  // form rather than rewriting, so the URL a visitor keeps (and a
  // crawler indexes) is the one we actually serve.
  if (uri.endsWith("/")) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: uri.slice(0, -1) } },
    };
  }

  // Extension-less paths are pages: /for-vendors -> for-vendors.html.
  // Anything with a dot in its last segment is an asset and is left
  // alone, so /_next/static/*.js is never rewritten.
  if (!uri.split("/").pop().includes(".")) {
    request.uri = uri + ".html";
  }

  return request;
}
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
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
        functionAssociations: [
          {
            function: rewriteToHtml,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      // With the rewrite function above, a 403/404 here means the .html
      // genuinely does not exist - so serve the static 404 page rather than
      // CloudFront's default XML error blob.
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




    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [s3deploy.Source.asset(path.resolve(siteBuildPath))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });

    // DNS is added by hand at the registrar; these are what it needs.
    new CfnOutput(this, "DistributionDomainName", {
      value: distribution.distributionDomainName,
      description: "Point the apex at this with an ALIAS record, and www with a CNAME.",
    });
    new CfnOutput(this, "DnsRecordsToAdd", {
      value: [
        `ALIAS ${domainName} -> ${distribution.distributionDomainName}`,
        `CNAME ${wwwDomainName} -> ${distribution.distributionDomainName}`,
      ].join(" | "),
      description: "The two records to create at the registrar.",
    });
    new CfnOutput(this, "SiteUrl", {
      value: `https://${domainName}`,
    });
    new CfnOutput(this, "BucketName", {
      value: siteBucket.bucketName,
    });
  }
}
