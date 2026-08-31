/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export: the console is a pure client-side app that talks to a
  // control plane over HTTP, so it can be served from anywhere - S3, a
  // CDN, or straight off the self-hosted control plane's own box. That
  // keeps the self-hosting story to "serve these files", with no second
  // Node process to run. It's also why org selection lives in a query
  // param rather than a dynamic route segment: `output: export` can't
  // pre-render `/orgs/[orgId]` for orgs that don't exist at build time.
  output: "export",
  images: { unoptimized: true },
};

module.exports = nextConfig;
