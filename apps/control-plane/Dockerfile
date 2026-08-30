# Self-hosted deployment image for the SecRefs control plane. See
# ../../docs/control-plane-design.md and README.md ("Self-hosting") in
# this directory for what this service does and doesn't guarantee.
#
# Build from the *repo root* (needs the workspace's package.json files to
# resolve pnpm-lock.yaml correctly):
#   docker build -f apps/control-plane/Dockerfile -t secrefs-control-plane .

FROM node:20-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

# better-sqlite3 compiles a native addon at install time - needs a C++
# toolchain in the build stage only, never in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Just the package.json files pnpm needs to resolve the workspace graph
# against the lockfile - keeps this layer cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/node/package.json packages/node/package.json
RUN pnpm install --frozen-lockfile

COPY apps/control-plane apps/control-plane
RUN pnpm --filter @secrefs/control-plane build
# Produces a self-contained deploy folder (real node_modules, not the
# workspace's symlinked store) - exactly what a plain `node dist/server.js`
# in the runtime stage needs, with only production dependencies.
RUN pnpm --filter @secrefs/control-plane deploy --prod /repo/out

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/out ./

EXPOSE 8787

# No cipher key or database ships in this image - both are supplied by
# whoever runs it. SECREFS_CP_CIPHER_KEY is required; the process exits
# immediately with instructions if it's missing (see src/server.ts).
CMD ["node", "dist/server.js"]
