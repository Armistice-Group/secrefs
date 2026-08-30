/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export - the site is served straight from S3 behind CloudFront
  // (see infra/cdk-stack.ts), with no Node.js server at runtime.
  output: "export",
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
