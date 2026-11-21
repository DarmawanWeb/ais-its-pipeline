# syntax=docker/dockerfile:1.7
#
# ais-its-pipeline image (docs/PLATFORM_SPEC.md §11, §13.2): ONE image, TWO
# processes. It is built once; the default command runs the processor, the
# ingestor is the same image with another command:
#
#   docker run … ghcr.io/darmawanweb/ais-its-pipeline                      # processor :3004
#   docker run … ghcr.io/darmawanweb/ais-its-pipeline \
#     node dist/apps/ingestor/main.js                                      # ingestor  :3003
#
# (compose: `command: ["node", "dist/apps/ingestor/main.js"]`). Each process
# defaults to its own port and SERVICE_NAME; PORT overrides both.
#
# Registry credentials only arrive as BuildKit secrets, never as build
# arguments or layers:
#   - npmrc (required): an .npmrc mapping @darmawanweb to its registry with a token
#   - ca (optional): an extra CA bundle for TLS-intercepting proxies
#
#   DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-pipeline .
#   # behind a TLS-intercepting proxy (corepack downloads pnpm, pnpm fetches packages):
#   DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
#     --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-pipeline .

# --- base: Node.js with pnpm (version from package.json "packageManager") ------
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HUSKY=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
RUN --mount=type=secret,id=ca,target=/tmp/build-ca.crt,required=false \
    if [ -s /tmp/build-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/build-ca.crt; fi; \
    corepack enable && corepack install

# --- build: all dependencies, compile TypeScript --------------------------------
FROM base AS build
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    --mount=type=secret,id=ca,target=/tmp/build-ca.crt,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -s /tmp/build-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/build-ca.crt; fi; \
    pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# --- prod-deps: production dependencies only -------------------------------------
FROM base AS prod-deps
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    --mount=type=secret,id=ca,target=/tmp/build-ca.crt,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    if [ -s /tmp/build-ca.crt ]; then export NODE_EXTRA_CA_CERTS=/tmp/build-ca.crt; fi; \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# --- runtime: non-root, production only -------------------------------------------
# No PORT here: the processor defaults to 3004 and the ingestor to 3003.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Processor only: SQL migrations (schema "ais") and the coast geometry
# (GEO_COASTLINE_PATH, loaded once at startup).
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node data ./data
USER node
# 3003 ingestor (REST + socket.io /api/v2/ingest/socket), 3004 processor.
EXPOSE 3003 3004
# Liveness of whichever process runs: PORT when set, else the processor's
# default port, then the ingestor's.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3004}/health/live" \
   || wget -q -O /dev/null "http://127.0.0.1:${PORT:-3003}/health/live" \
   || exit 1
CMD ["node", "dist/apps/processor/main.js"]
